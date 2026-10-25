export class MessageIdentity {
  constructor(limit?: number);
  remember(sessionID: string, messageID: string): void;
  require(sessionID: string): string;
}
export function validID(id: unknown): id is string;
