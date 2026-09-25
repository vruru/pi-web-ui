import { expect, it } from "vitest";
import { syncQueuedImages } from "../../server/queued-attachments.js";
const image = (data: string) => [{ type: "image" as const, data, mimeType: "image/png" }];
it("keeps images when a plain message is appended", () => {
	const first = { text: "same", images: image("first") };
	expect(syncQueuedImages([first], ["same", "same"])).toEqual([first, { text: "same" }]);
});
it("consuming the first duplicate keeps the later image", () => {
	const first = { text: "same", images: image("first") },
		second = { text: "same", images: image("second") };
	expect(syncQueuedImages([first, second], ["same"])).toEqual([second]);
});
it("cleared queues release image references", () => {
	expect(syncQueuedImages([{ text: "x", images: image("x") }], [])).toEqual([]);
});
