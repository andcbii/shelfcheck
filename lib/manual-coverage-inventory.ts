import type { CoverageCorrection, CoverageEvidence, CoverageMapping } from "@/lib/manual-coverage-model";

function sameIdentity(a: { provider: string; id: number }, b: { provider: string; id: number }) {
  return a.provider === b.provider && a.id === b.id;
}

/** Project current direct ownership without mutating inventory or reading persisted corrections. */
export function applyCoverageCorrections(mapping: CoverageMapping, inventory: CoverageEvidence[], allCorrections: CoverageCorrection[]): CoverageEvidence[] {
  const corrections = allCorrections.filter(correction => correction.mappingId === mapping.id);
  return inventory.map(item => {
    const correction = corrections.find(candidate => candidate.showKey === item.showKey && candidate.ratingKey === item.ratingKey && candidate.fingerprint === item.fingerprint);
    const unclaimed = item.identities.filter(identity => !mapping.members.some(member => sameIdentity(member, identity)));
    if (correction) return { ...item, identities: unclaimed.concat(correction.identities) };
    const claimed = mapping.members.filter(member => item.identities.some(identity => sameIdentity(member, identity)));
    const ambiguous = mapping.members.length > 2 && new Set(claimed.map(member => member.provider)).size === 2;
    return ambiguous ? { ...item, identities: unclaimed } : item;
  });
}
