import type { DetectedEntity, RiskLevel } from "@brainbuddy/domain";

const riskWeight: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};

export function collectMatches(
  text: string,
  pattern: RegExp,
  create: (match: RegExpExecArray) => DetectedEntity | undefined
): DetectedEntity[] {
  if (!pattern.global) {
    throw new Error("Recognizer patterns must use the global flag");
  }

  const entities: DetectedEntity[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const entity = create(match);
    if (entity) entities.push(entity);
  }
  return entities;
}

export function resolveOverlaps(entities: readonly DetectedEntity[]): DetectedEntity[] {
  const byPriority = [...entities].sort((left, right) => {
    const riskDifference = riskWeight[right.risk] - riskWeight[left.risk];
    if (riskDifference !== 0) return riskDifference;
    const lengthDifference = right.end - right.start - (left.end - left.start);
    if (lengthDifference !== 0) return lengthDifference;
    return left.start - right.start;
  });

  const accepted: DetectedEntity[] = [];
  for (const candidate of byPriority) {
    const overlaps = accepted.some(
      (entity) => candidate.start < entity.end && candidate.end > entity.start
    );
    if (!overlaps) accepted.push(candidate);
  }

  return accepted.sort((left, right) => left.start - right.start);
}

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}
