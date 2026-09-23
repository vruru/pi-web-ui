/** Count asynchronous browser requests that have already entered the session,
 * including model/session changes before the SDK starts streaming. */
export class CoreUpdateWorkTracker {
	private count = 0;
	get pending(): number {
		return this.count;
	}
	wrap<T extends object>(target: T): T {
		return new Proxy(target, {
			get: (object, key) => {
				const value = Reflect.get(object, key, object);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					this.count++;
					try {
						const result = Reflect.apply(value, object, args);
						if (result instanceof Promise) return result.finally(() => this.count--);
						this.count--;
						return result;
					} catch (error) {
						this.count--;
						throw error;
					}
				};
			},
		});
	}
}
