/** Work already admitted before an SDK stream exists must drain before replacing
 * the SDK. Weak ownership also covers session initialization without retaining it. */
const pending = new WeakMap<object, number>();
export function pendingCoreWork(owner: object): number {
	return pending.get(owner) ?? 0;
}
export async function withCoreWork<T>(owner: object, work: () => Promise<T>): Promise<T> {
	pending.set(owner, pendingCoreWork(owner) + 1);
	try {
		return await work();
	} finally {
		const count = pendingCoreWork(owner) - 1;
		if (count > 0) pending.set(owner, count);
		else pending.delete(owner);
	}
}
