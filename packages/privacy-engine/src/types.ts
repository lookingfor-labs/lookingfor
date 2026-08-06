import type { DetectedEntity } from "@brainbuddy/domain";

export interface Recognizer {
  readonly id: string;
  recognize(text: string): readonly DetectedEntity[];
}
