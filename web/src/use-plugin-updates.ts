import { useEffect, useState } from "react";
import { appUrl } from "./base-url";
import { withToken } from "./auth-token";

/** Unknown and failed checks never advertise an update. Recheck after install jobs. */
export function usePluginUpdates(active: boolean, revision: string) {
	const [available, setAvailable] = useState<Set<string>>(new Set());
	useEffect(() => {
		setAvailable(new Set());
		if (!active) return;
		const controller = new AbortController();
		const check = async () => {
			try {
				const response = await fetch(withToken(appUrl("/api/plugin-updates")), { signal: controller.signal });
				if (!response.ok) throw new Error("Update check failed");
				const data = await response.json();
				if (!controller.signal.aborted)
					setAvailable(
						new Set(
							(data.updates ?? [])
								.filter((p: { updatable?: boolean }) => p.updatable === true)
								.map((p: { id: string }) => p.id),
						),
					);
			} catch {
				if (!controller.signal.aborted) setAvailable(new Set());
			}
		};
		void check();
		const timer = setInterval(() => void check(), 60000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [active, revision]);
	return available;
}
