/**
 * Keeping up with changes in Knack.
 *
 * Shared by the `npm run sync` script (deploy time) and the running server
 * (automatic re-sync), so both judge a change the same way.
 */
import type { AppSnapshot, TemplateManifest } from '../knack/loader.js';
import { buildModel, lockOf, toEntitySlug, toFieldSlug, type AppModel } from './model.js';

export interface TemplateCheck {
  /** Required tables/fields that are gone: the template's screens can't work. */
  problems: string[];
  /** Optional ones that are gone: a feature switches off. */
  missingOptional: string[];
  /** Renamed in Knack, still mapped through the slug lock. */
  renamed: string[];
}

/**
 * Check the app against the template manifest.
 *
 * A table or field passes if it exists under the template's name, OR under the
 * slug that name produces. The second case is a rename in Knack that the slug
 * lock has absorbed: the screens still work, and we say what changed.
 */
export const checkTemplate = (model: AppModel, manifest: TemplateManifest | undefined): TemplateCheck => {
  const out: TemplateCheck = { problems: [], missingOptional: [], renamed: [] };
  if (!manifest) return out;

  const walk = (groups: Record<string, string[]> | undefined, sink: string[]) => {
    for (const [entityName, fields] of Object.entries(groups ?? {})) {
      const entity = model.entities.find((e) => e.name === entityName) ?? model.bySlug.get(toEntitySlug(entityName));
      if (!entity) {
        sink.push(`The "${entityName}" table is missing.`);
        continue;
      }
      if (entity.name !== entityName) out.renamed.push(`Table "${entityName}" is now called "${entity.name}".`);
      for (const fieldName of fields) {
        const field = entity.fields.find((f) => f.name === fieldName) ?? entity.bySlug.get(toFieldSlug(fieldName));
        if (!field) sink.push(`"${entity.name}" is missing the "${fieldName}" field.`);
        else if (field.name !== fieldName) out.renamed.push(`"${entity.name}.${fieldName}" is now called "${field.name}".`);
      }
    }
  };
  walk(manifest.entities, out.problems);
  walk(manifest.optional, out.missingOptional);

  for (const [role, name] of Object.entries(manifest.roles)) {
    const entity = model.entities.find((e) => e.name === name) ?? model.bySlug.get(toEntitySlug(name));
    if (!entity?.isUser) out.problems.push(`The ${role} experience needs a user role named "${name}".`);
  }
  out.renamed = [...new Set(out.renamed)];
  return out;
};

/**
 * The next snapshot: fresh structure from Knack, with the template and the
 * slug lock carried forward from the previous one. Every key seen before keeps
 * its slug; new keys get one from their name, which is then locked too.
 */
export const carryForward = (previous: AppSnapshot | null, next: AppSnapshot): AppSnapshot => {
  const withLock: AppSnapshot = { ...next, template: next.template ?? previous?.template, slugs: { ...(previous?.slugs ?? {}) } };
  const model = buildModel(withLock);
  return { ...withLock, slugs: { ...(previous?.slugs ?? {}), ...lockOf(model) } };
};

/** Human-readable differences between two snapshots, for the admin and the log. */
export const diffSnapshots = (before: AppSnapshot, after: AppSnapshot): string[] => {
  const changes: string[] = [];
  const oldObjects = new Map(before.objects.map((o) => [o.key, o]));
  const newObjects = new Map(after.objects.map((o) => [o.key, o]));
  for (const [key, o] of newObjects) {
    const prev = oldObjects.get(key);
    if (!prev) {
      changes.push(`Table added: "${o.name}".`);
      continue;
    }
    if (prev.name !== o.name) changes.push(`Table renamed: "${prev.name}" → "${o.name}".`);
    const oldFields = new Map(prev.fields.map((f) => [f.key, f]));
    const newFields = new Map(o.fields.map((f) => [f.key, f]));
    for (const [fk, f] of newFields) {
      const pf = oldFields.get(fk);
      if (!pf) changes.push(`Field added: "${o.name}.${f.name}".`);
      else {
        if (pf.name !== f.name) changes.push(`Field renamed: "${o.name}.${pf.name}" → "${f.name}".`);
        if (pf.type !== f.type) changes.push(`Field type changed: "${o.name}.${f.name}" ${pf.type} → ${f.type}.`);
        const po = JSON.stringify(pf.format?.options ?? null);
        const no = JSON.stringify(f.format?.options ?? null);
        if (po !== no) changes.push(`Choices changed: "${o.name}.${f.name}".`);
      }
    }
    for (const [fk, f] of oldFields) if (!newFields.has(fk)) changes.push(`Field deleted: "${o.name}.${f.name}".`);
  }
  for (const [key, o] of oldObjects) if (!newObjects.has(key)) changes.push(`Table deleted: "${o.name}".`);

  // Pages and views carry the access rules. Compare them as a whole and say
  // which pages changed, without trying to describe the edit.
  const pageSig = (s: AppSnapshot) =>
    new Map(s.scenes.map((sc) => [sc.key, JSON.stringify([sc.slug, sc.parent, sc.object, sc.authenticated, sc.views])]));
  const oldPages = pageSig(before);
  const newPages = pageSig(after);
  const names = new Map(after.scenes.map((sc) => [sc.key, sc.name]));
  const oldNames = new Map(before.scenes.map((sc) => [sc.key, sc.name]));
  for (const [key, sig] of newPages) {
    if (!oldPages.has(key)) changes.push(`Page added: "${names.get(key)}".`);
    else if (oldPages.get(key) !== sig) changes.push(`Page changed: "${names.get(key)}".`);
  }
  for (const key of oldPages.keys()) if (!newPages.has(key)) changes.push(`Page deleted: "${oldNames.get(key)}".`);
  return changes;
};
