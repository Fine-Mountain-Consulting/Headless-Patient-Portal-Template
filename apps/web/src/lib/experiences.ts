/**
 * Which experience each Knack role gets.
 *
 * The template's roles are named in templates/<template>/manifest.json. A
 * role the template doesn't know (one the customer added in Knack) still gets
 * a working experience: the generic one, built from what the server says that
 * role may do.
 */
import manifest from '../../../../templates/patient-portal/manifest.json';
import type { RoleInfo } from './session';

export type ExperienceKind = 'patient' | 'doctor' | 'staff' | 'admin' | 'generic';

export interface Experience {
  kind: ExperienceKind;
  role: RoleInfo;
  /** Route prefix. */
  base: string;
  label: string;
}

const byName: Record<string, ExperienceKind> = Object.fromEntries(
  Object.entries(manifest.roles as Record<string, string>).map(([kind, name]) => [name, kind as ExperienceKind]),
);

const LABELS: Record<ExperienceKind, string> = {
  patient: 'Patient',
  doctor: 'Clinician',
  staff: 'Staff',
  admin: 'Administrator',
  generic: '',
};

export const experienceFor = (role: RoleInfo): Experience => {
  const kind = role.admin ? 'admin' : (byName[role.name] ?? 'generic');
  return {
    kind,
    role,
    base: kind === 'generic' ? `/r/${role.slug}` : `/${kind}`,
    label: LABELS[kind] || role.name,
  };
};

export const experiencesFor = (roles: RoleInfo[]): Experience[] => {
  const seen = new Set<string>();
  return roles.map(experienceFor).filter((e) => (seen.has(e.base) ? false : (seen.add(e.base), true)));
};

const LAST_KEY = 'headless.lastExperience';
export const rememberExperience = (base: string) => {
  try {
    sessionStorage.setItem(LAST_KEY, base);
  } catch {
    /* ignore */
  }
};
export const lastExperience = (): string | null => {
  try {
    return sessionStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
};
