export function enforceTextOnlyContext(event: {
  model: { providerID: string };
  tools: Record<string, unknown>;
}): boolean;
