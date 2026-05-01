/**
 * Schema Monitor — detects Claude Code format changes between versions.
 *
 * On each collection run, computes a fingerprint of the observed schema
 * (field sets per message type, usage fields, known message types).
 * When a new Claude Code version introduces changes, emits warnings before
 * full collection proceeds.
 *
 * See doc/analysis/08-resilience.md — Schema Fingerprinting.
 */
import type { RawSessionEntry, SchemaFingerprint } from "@claude-stats/core/types";
import type { Store } from "../store/index.js";

export interface SchemaDiff {
  version: string;
  isNew: boolean;
  addedTypes: string[];
  removedTypes: string[];
  addedFields: Record<string, string[]>;
  removedFields: Record<string, string[]>;
  addedUsageFields: string[];
  removedUsageFields: string[];
}

/** Build a fingerprint from a sample of parsed entries. */
export function buildFingerprint(
  claudeVersion: string,
  entries: RawSessionEntry[]
): SchemaFingerprint {
  const fieldsByType: Record<string, Set<string>> = {};
  const usageFields = new Set<string>();
  const messageTypes = new Set<string>();

  for (const entry of entries) {
    const type = entry.type ?? "__unknown__";
    messageTypes.add(type);

    if (!fieldsByType[type]) fieldsByType[type] = new Set();
    for (const key of Object.keys(entry)) {
      fieldsByType[type]!.add(key);
    }

    if (entry.message?.usage) {
      for (const key of Object.keys(entry.message.usage)) {
        usageFields.add(key);
      }
    }
  }

  return {
    claudeVersion,
    capturedAt: Date.now(),
    messageTypes: Array.from(messageTypes).sort(),
    fieldsByType: Object.fromEntries(
      Object.entries(fieldsByType).map(([k, v]) => [k, Array.from(v).sort()])
    ),
    usageFields: Array.from(usageFields).sort(),
  };
}

/** Compare a new fingerprint against the stored one for the same version.
 *  Returns null if there is no stored fingerprint (first time seeing this version). */
export function diffFingerprints(
  newFp: SchemaFingerprint,
  oldFp: SchemaFingerprint
): SchemaDiff {
  const addedTypes = newFp.messageTypes.filter(
    (t) => !oldFp.messageTypes.includes(t)
  );
  const removedTypes = oldFp.messageTypes.filter(
    (t) => !newFp.messageTypes.includes(t)
  );

  const addedFields: Record<string, string[]> = {};
  const removedFields: Record<string, string[]> = {};
  const allTypes = new Set([
    ...Object.keys(newFp.fieldsByType),
    ...Object.keys(oldFp.fieldsByType),
  ]);

  for (const type of allTypes) {
    const newFields = newFp.fieldsByType[type] ?? [];
    const oldFields = oldFp.fieldsByType[type] ?? [];
    const added = newFields.filter((f) => !oldFields.includes(f));
    const removed = oldFields.filter((f) => !newFields.includes(f));
    if (added.length) addedFields[type] = added;
    if (removed.length) removedFields[type] = removed;
  }

  const addedUsageFields = newFp.usageFields.filter(
    (f) => !oldFp.usageFields.includes(f)
  );
  const removedUsageFields = oldFp.usageFields.filter(
    (f) => !newFp.usageFields.includes(f)
  );

  return {
    version: newFp.claudeVersion,
    isNew: false,
    addedTypes,
    removedTypes,
    addedFields,
    removedFields,
    addedUsageFields,
    removedUsageFields,
  };
}

export function hasDiff(diff: SchemaDiff): boolean {
  return (
    diff.addedTypes.length > 0 ||
    diff.removedTypes.length > 0 ||
    Object.keys(diff.addedFields).length > 0 ||
    Object.keys(diff.removedFields).length > 0 ||
    diff.addedUsageFields.length > 0 ||
    diff.removedUsageFields.length > 0
  );
}

/** Check and store fingerprint, return any diff detected. */
export function checkSchema(
  store: Store,
  claudeVersion: string,
  entries: RawSessionEntry[]
): SchemaDiff | null {
  if (!claudeVersion || entries.length === 0) return null;

  const newFp = buildFingerprint(claudeVersion, entries);
  const stored = store.getFingerprint(claudeVersion);

  if (!stored) {
    store.upsertFingerprint(newFp);
    return { version: claudeVersion, isNew: true, addedTypes: [], removedTypes: [], addedFields: {}, removedFields: {}, addedUsageFields: [], removedUsageFields: [] };
  }

  const diff = diffFingerprints(newFp, stored);
  if (hasDiff(diff)) {
    // Update stored fingerprint to the union of old+new (additive only)
    const merged = mergeFingerprints(stored, newFp);
    store.upsertFingerprint(merged);
  }
  return hasDiff(diff) ? diff : null;
}

function mergeFingerprints(
  a: SchemaFingerprint,
  b: SchemaFingerprint
): SchemaFingerprint {
  const messageTypes = Array.from(
    new Set([...a.messageTypes, ...b.messageTypes])
  ).sort();
  const usageFields = Array.from(
    new Set([...a.usageFields, ...b.usageFields])
  ).sort();
  const allTypes = new Set([
    ...Object.keys(a.fieldsByType),
    ...Object.keys(b.fieldsByType),
  ]);
  const fieldsByType: Record<string, string[]> = {};
  for (const type of allTypes) {
    fieldsByType[type] = Array.from(
      new Set([...(a.fieldsByType[type] ?? []), ...(b.fieldsByType[type] ?? [])])
    ).sort();
  }
  return {
    claudeVersion: b.claudeVersion,
    capturedAt: b.capturedAt,
    messageTypes,
    fieldsByType,
    usageFields,
  };
}
