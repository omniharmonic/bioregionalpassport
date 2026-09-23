/** Confirmation sentences for steward actions, keyed by the `?done=` marker the console page reads back. */
export const DONE = {
  created: 'Round created as a draft. Open it when it is ready.',
  open: 'The round is open.',
  close: 'Voting is closed and the ballots are counted. Review, then publish.',
  publish: 'Results are published as open records.',
  adjusted: 'Adjustment logged; the count was updated.',
} as const;
export type DoneKey = keyof typeof DONE;

export const isDoneKey = (v: unknown): v is DoneKey => typeof v === 'string' && Object.hasOwn(DONE, v);
