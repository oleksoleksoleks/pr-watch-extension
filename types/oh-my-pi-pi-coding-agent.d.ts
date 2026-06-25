declare module "@oh-my-pi/pi-coding-agent" {
	export interface ExecResult {
		code: number;
		stdout: string;
		stderr: string;
	}

	export interface ExtensionAPI {
		setLabel(label: string): void;
		registerCommand(name: string, command: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void> }): void;
		on(event: string, handler: () => void): void;
		exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult>;
	}

	export interface ExtensionContext {
		cwd: string;
		sessionManager: {
			getSessionFile(): string | undefined;
			getSessionId(): string;
		};
		ui: {
			notify(message: string, type?: "info" | "warning" | "error"): void;
			setWidget(name: string, lines: string[] | undefined, options?: { placement?: string }): void;
		};
	}

	export interface ExtensionCommandContext extends ExtensionContext {}
}
