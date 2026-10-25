export class GatewayLifecycle {
  constructor(options: {
    entry: string;
    runtimeExecutable?: string;
    runtimeData?: string;
    key: string;
    port?: number;
    node: string;
  });
  ensure(): Promise<void>;
  stop(): void;
}
