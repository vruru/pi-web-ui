import { describe, it, expect } from "vitest";
import { parseXlsxSheets } from "../../server/office-parse.js";
import { deflateRawSync } from "node:zlib";

function createMockZip(files: Record<string, Buffer>): Buffer {
	const entries: Array<{
		name: string;
		data: Buffer;
		compData: Buffer;
		offset: number;
		crc: number;
	}> = [];

	let currentOffset = 0;
	const localChunks: Buffer[] = [];

	for (const [name, data] of Object.entries(files)) {
		const compData = deflateRawSync(data);
		const nameBuf = Buffer.from(name, "utf8");
		const localHeader = Buffer.alloc(30 + nameBuf.length);

		localHeader.writeUInt32LE(0x04034b50, 0); // local file header sig
		localHeader.writeUInt16LE(20, 4); // version needed
		localHeader.writeUInt16LE(0, 6); // flags
		localHeader.writeUInt16LE(8, 8); // compression method (deflate)
		localHeader.writeUInt16LE(0, 10); // mod time
		localHeader.writeUInt16LE(0, 12); // mod date
		localHeader.writeUInt32LE(0, 14); // crc32
		localHeader.writeUInt32LE(compData.length, 18); // compSize
		localHeader.writeUInt32LE(data.length, 22); // uncompSize
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28);
		nameBuf.copy(localHeader, 30);

		entries.push({
			name,
			data,
			compData,
			offset: currentOffset,
			crc: 0,
		});

		localChunks.push(localHeader, compData);
		currentOffset += localHeader.length + compData.length;
	}

	const cdStart = currentOffset;
	const cdChunks: Buffer[] = [];

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const cdHeader = Buffer.alloc(46 + nameBuf.length);

		cdHeader.writeUInt32LE(0x02014b50, 0); // CD header sig
		cdHeader.writeUInt16LE(20, 4);
		cdHeader.writeUInt16LE(20, 6);
		cdHeader.writeUInt16LE(0, 8);
		cdHeader.writeUInt16LE(8, 10);
		cdHeader.writeUInt16LE(0, 12);
		cdHeader.writeUInt16LE(0, 14);
		cdHeader.writeUInt32LE(entry.crc, 16);
		cdHeader.writeUInt32LE(entry.compData.length, 20);
		cdHeader.writeUInt32LE(entry.data.length, 24);
		cdHeader.writeUInt16LE(nameBuf.length, 28);
		cdHeader.writeUInt16LE(0, 30);
		cdHeader.writeUInt16LE(0, 32);
		cdHeader.writeUInt16LE(0, 34);
		cdHeader.writeUInt16LE(0, 36);
		cdHeader.writeUInt32LE(0, 38);
		cdHeader.writeUInt32LE(entry.offset, 42);
		nameBuf.copy(cdHeader, 46);

		cdChunks.push(cdHeader);
		currentOffset += cdHeader.length;
	}

	const cdSize = currentOffset - cdStart;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdStart, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localChunks, ...cdChunks, eocd]);
}

describe("Office Parse DoS & Zip Bomb Protection (#337)", () => {
	it("safely handles huge row & column indices without OOM crash", () => {
		const maliciousSheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Normal cell</t></is></c>
    </row>
    <row r="999999999">
      <c r="ZZZZ999999999" t="inlineStr"><is><t>Huge cell</t></is></c>
    </row>
  </sheetData>
</worksheet>`;

		const mockZip = createMockZip({
			"xl/workbook.xml": Buffer.from(
				`<?xml version="1.0"?><workbook><sheets><sheet name="TestSheet" r:id="rId1"/></sheets></workbook>`,
				"utf8",
			),
			"xl/_rels/workbook.xml.rels": Buffer.from(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
				"utf8",
			),
			"xl/worksheets/sheet1.xml": Buffer.from(maliciousSheetXml, "utf8"),
		});

		const sheets = parseXlsxSheets(mockZip);
		expect(sheets.length).toBe(1);
		const sheet = sheets[0];
		expect(sheet.name).toBe("TestSheet");
		expect(sheet.truncated).toBe(true);
		expect(sheet.nRows).toBe(999999999);
		// 验证内存中 rows 数组受到严格限制，绝未预分配 999999999 个空行
		expect(sheet.rows.length).toBeLessThanOrEqual(500);
	});
});
