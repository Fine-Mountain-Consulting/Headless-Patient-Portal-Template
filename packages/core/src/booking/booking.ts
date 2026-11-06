/**
 * Online booking.
 *
 * Who may book is decided by the Knack pages, like everything else: booking
 * is offered only to a role whose pages include a form that creates
 * Appointments with the date and doctor as inputs. The server writes the
 * appointment the way that form would (forced connection to the signed-in
 * patient, the form's record rules), plus the appointment's length from the
 * doctor's schedule.
 *
 * Availability needs every doctor's existing appointments, which no patient
 * may see. The server reads them with the master key and returns ONLY busy
 * intervals per doctor: no patient, no reason, no record ids. Booking
 * re-validates against a fresh read, so a stale screen can't double-book.
 */
import type { Policy, Caller } from '../access/policy.js';
import type { KnackClient } from '../knack/client.js';
import type { BookingConfig } from '../knack/loader.js';
import { connectionIds, readField, toKnackValue, type KnackRecord } from '../knack/values.js';
import type { AppModel, EntityModel, FieldModel } from '../model/model.js';
import { addDaysYmd, hoursFrom, slotProblem, SLOT_PROBLEM_TEXT, zoned, type DoctorHours, type Interval } from './slots.js';

export interface BookableDoctor {
  id: string;
  name: string;
  specialty: string | null;
  hours: DoctorHours;
}

export interface Resolved {
  appts: EntityModel;
  date: FieldModel;
  doctor: FieldModel;
  patient?: FieldModel;
  reason?: FieldModel;
  duration?: FieldModel;
  status?: FieldModel;
  cancelled: Set<string>;
  doctors: EntityModel;
  d: { specialty?: FieldModel; days?: FieldModel; start?: FieldModel; end?: FieldModel; length?: FieldModel; online?: FieldModel };
  timeOff?: { entity: EntityModel; starts: FieldModel; ends: FieldModel; doctor: FieldModel };
}

export class BookingError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const byName = (e: EntityModel | undefined, name: string | undefined) => (e && name ? e.fields.find((f) => f.name === name) : undefined);

export class BookingService {
  readonly resolved: Resolved | null;
  private busyCache: { at: number; key: string; records: KnackRecord[] } | null = null;

  constructor(
    private readonly model: AppModel,
    private readonly policy: Policy,
    private readonly knack: KnackClient,
    config: BookingConfig | undefined,
  ) {
    this.resolved = config ? this.resolve(config) : null;
  }

  private resolve(c: BookingConfig): Resolved | null {
    const appts = this.model.entities.find((e) => e.name === c.appointments);
    const doctors = this.model.entities.find((e) => e.name === c.doctors);
    const date = byName(appts, c.date);
    const doctor = byName(appts, c.doctor);
    if (!appts || !doctors || !date || !doctor || doctor.targetObject !== doctors.objectKey) return null;
    const off = this.model.entities.find((e) => e.name === c.timeOff);
    const offStarts = byName(off, c.timeOffStarts);
    const offEnds = byName(off, c.timeOffEnds);
    const offDoctor = byName(off, c.timeOffDoctor);
    return {
      timeOff: off && offStarts && offEnds && offDoctor?.targetObject === doctors.objectKey ? { entity: off, starts: offStarts, ends: offEnds, doctor: offDoctor } : undefined,
      appts,
      date,
      doctor,
      patient: byName(appts, c.patient),
      reason: byName(appts, c.reason),
      duration: byName(appts, c.duration),
      status: byName(appts, c.status),
      cancelled: new Set((c.cancelledStatuses ?? ['Cancelled']).map((s) => s.toLowerCase())),
      doctors,
      d: {
        specialty: byName(doctors, c.specialty),
        days: byName(doctors, c.availableDays),
        start: byName(doctors, c.dayStarts),
        end: byName(doctors, c.dayEnds),
        length: byName(doctors, c.appointmentLength),
        online: byName(doctors, c.onlineBooking),
      },
    };
  }

  /** Booking is offered when the caller's Knack form creates appointments with date and doctor inputs. */
  canBook(caller: Caller): boolean {
    const r = this.resolved;
    if (!r) return false;
    const { grants, fields } = this.policy.resolve(caller, r.appts.objectKey, 'create');
    return grants.length > 0 && fields.has(r.date.key) && fields.has(r.doctor.key);
  }

  private require(caller: Caller): Resolved {
    if (!this.canBook(caller)) throw new BookingError(403, 'Online booking isn’t available for your account.');
    return this.resolved!;
  }

  async doctors(caller: Caller): Promise<BookableDoctor[]> {
    const r = this.require(caller);
    const { records } = await this.knack.listAll(r.doctors.objectKey, {}, 500);
    const identifier = r.doctors.identifierKey ? r.doctors.byKey.get(r.doctors.identifierKey) : undefined;
    const out: BookableDoctor[] = [];
    for (const rec of records) {
      if (r.d.online && readField(rec, r.d.online) === false) continue;
      const nameValue = identifier ? readField(rec, identifier) : null;
      const name = nameValue && typeof nameValue === 'object' ? String((nameValue as { full?: string }).full ?? '') : String(nameValue ?? '');
      out.push({
        id: rec.id,
        name: name || 'Doctor',
        specialty: r.d.specialty ? ((readField(rec, r.d.specialty) as string | null) ?? null) : null,
        hours: hoursFrom({
          days: r.d.days ? readField(rec, r.d.days) : undefined,
          start: r.d.start ? readField(rec, r.d.start) : undefined,
          end: r.d.end ? readField(rec, r.d.end) : undefined,
          length: r.d.length ? readField(rec, r.d.length) : undefined,
        }),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Busy intervals per doctor between two dates, and the caller's own
   * appointments (so they can't double-book themselves). No identities.
   */
  async availability(caller: Caller, from: string, to: string, fresh = false): Promise<{ busy: Record<string, Interval[]>; mine: Interval[] }> {
    const r = this.require(caller);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
      throw new BookingError(400, 'Invalid date range.');
    }
    if (new Date(to).getTime() - new Date(from).getTime() > 62 * 864e5) throw new BookingError(400, 'Ask for at most two months at a time.');

    const mineField = await this.myConnection(caller);
    const records = await this.appointmentsBetween(r, from, to, fresh);
    const doctorLength = new Map((await this.doctors(caller)).map((d) => [d.id, d.hours.length]));

    const busy: Record<string, Interval[]> = {};
    const mine: Interval[] = [];
    for (const rec of records) {
      const status = r.status ? String(readField(rec, r.status) ?? '').toLowerCase() : '';
      if (r.cancelled.has(status)) continue;
      const startIso = readField(rec, r.date);
      if (typeof startIso !== 'string') continue;
      const start = new Date(startIso).getTime();
      if (Number.isNaN(start)) continue;
      const doctorIds = connectionIds(rec, r.doctor.key);
      const minutes = (r.duration ? (readField(rec, r.duration) as number | null) : null) ?? doctorLength.get(doctorIds[0] ?? '') ?? 30;
      const interval: Interval = [start, start + Math.max(5, minutes) * 60_000];
      for (const id of doctorIds) (busy[id] ??= []).push(interval);
      if (mineField && connectionIds(rec, mineField.field).includes(mineField.id)) mine.push(interval);
    }
    // Time off is busy time too.
    if (r.timeOff) {
      const t = r.timeOff;
      const { records: offs } = await this.knack.listAll(
        t.entity.objectKey,
        {
          filters: {
            match: 'and',
            rules: [
              { field: t.ends.key, operator: 'is after', value: addDaysYmd(from, -1) },
              { field: t.starts.key, operator: 'is before', value: addDaysYmd(to, 1) },
            ],
          },
        },
        2000,
      );
      for (const rec of offs) {
        const s = new Date(String(readField(rec, t.starts) ?? '')).getTime();
        const e = new Date(String(readField(rec, t.ends) ?? '')).getTime();
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
        for (const id of connectionIds(rec, t.doctor.key)) (busy[id] ??= []).push([s, e]);
      }
    }
    return { busy, mine };
  }

  /** The connection a booking forces (the caller's own record), from the create grant. */
  private async myConnection(caller: Caller): Promise<{ field: string; id: string } | null> {
    const r = this.resolved!;
    const { forced } = await this.policy.createScope(caller, r.appts, {}, this.knack).catch(() => ({ forced: {} as Record<string, string[]> }));
    const [field, ids] = Object.entries(forced)[0] ?? [];
    return field && ids?.[0] ? { field, id: ids[0] } : null;
  }

  private async appointmentsBetween(r: Resolved, from: string, to: string, fresh: boolean): Promise<KnackRecord[]> {
    const key = `${from}|${to}`;
    if (!fresh && this.busyCache && this.busyCache.key === key && Date.now() - this.busyCache.at < 30_000) return this.busyCache.records;
    const { records } = await this.knack.listAll(
      r.appts.objectKey,
      {
        filters: {
          match: 'and',
          rules: [
            { field: r.date.key, operator: 'is after', value: addDaysYmd(from, -1) },
            { field: r.date.key, operator: 'is before', value: addDaysYmd(to, 1) },
          ],
        },
      },
      5000,
    );
    this.busyCache = { at: Date.now(), key, records };
    return records;
  }

  /** Validate and write a booking. Returns the created record. */
  async book(
    caller: Caller,
    input: { doctorId: unknown; start: unknown; reason: unknown; patientId?: unknown },
    tz: string,
    applyRules: (values: Record<string, unknown>, rules: import('../access/derive.js').FormRule[]) => Promise<void>,
  ): Promise<KnackRecord> {
    const r = this.require(caller);
    const doctorId = typeof input.doctorId === 'string' ? input.doctorId : '';
    const start = typeof input.start === 'number' ? input.start : typeof input.start === 'string' ? new Date(input.start).getTime() : NaN;
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 1000) : '';
    if (!Number.isFinite(start)) throw new BookingError(400, 'Choose a time.');

    const doctor = (await this.doctors(caller)).find((d) => d.id === doctorId);
    if (!doctor) throw new BookingError(400, 'Choose a doctor who takes online bookings.');
    if (r.reason?.required && !reason) throw new BookingError(400, 'Tell us the reason for your visit.');

    const day = zoned(start, tz).ymd;
    const { busy, mine } = await this.availability(caller, day, day, true);
    const problem = slotProblem(start, doctor.hours, busy[doctor.id] ?? [], mine, tz);
    if (problem) throw new BookingError(problem === 'doctor-busy' || problem === 'you-are-busy' ? 409 : 400, SLOT_PROBLEM_TEXT[problem]);

    const { forced, rules } = await this.policy.createScope(caller, r.appts, {}, this.knack);
    const { fields: writable } = this.policy.resolve(caller, r.appts.objectKey, 'create');

    const wall = zoned(start, tz);
    const hh = String(Math.floor(wall.minutes / 60)).padStart(2, '0');
    const mm = String(wall.minutes % 60).padStart(2, '0');
    const values: Record<string, unknown> = {
      [r.date.key]: toKnackValue(r.date, `${wall.ymd}T${hh}:${mm}`),
      [r.doctor.key]: [doctor.id],
    };
    if (r.reason && reason && writable.has(r.reason.key)) values[r.reason.key] = toKnackValue(r.reason, reason);
    // Length comes from the doctor's schedule, not from the patient.
    if (r.duration) values[r.duration.key] = doctor.hours.length;
    for (const [key, ids] of Object.entries(forced)) values[key] = ids;
    // A role that may create any appointment (staff) books FOR a patient, who
    // must be named and must exist. A patient's own booking is forced above.
    if (r.patient && !(r.patient.key in forced)) {
      const pid = typeof input.patientId === 'string' ? input.patientId : '';
      if (!pid || !r.patient.targetObject || !(await this.knack.get(r.patient.targetObject, pid))) {
        throw new BookingError(400, 'Choose the patient this appointment is for.');
      }
      values[r.patient.key] = [pid];
    }
    await applyRules(values, rules);

    return this.knack.create(r.appts.objectKey, values);
  }
}

