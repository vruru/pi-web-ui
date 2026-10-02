/** office-parse 纯函数单测：内存拼最小 zip，不碰文件系统。 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractOfficeText, isOfficeFile, parseDocxParagraphs, parseXlsxSheets } from "../../server/office-parse.js";

/** 最小 zip 写器（stored/deflate，带中央目录）。 */
function makeZip(entries: { name: string; data: string; method?: number }[]): Buffer {
	const chunks: Buffer[] = [];
	const central: { nameBuf: Buffer; method: number; compLen: number; rawLen: number; offset: number }[] = [];
	let offset = 0;
	for (const { name, data, method = 8 } of entries) {
		const raw = Buffer.from(data, "utf8");
		const comp = method === 8 ? deflateRawSync(raw) : raw;
		const nameBuf = Buffer.from(name, "utf8");
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(method, 10);
		lh.writeUInt32LE(comp.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(nameBuf.length, 26);
		chunks.push(lh, nameBuf, comp);
		central.push({ nameBuf, method, compLen: comp.length, rawLen: raw.length, offset });
		offset += 30 + nameBuf.length + comp.length;
	}
	const cdStart = offset;
	const cdChunks: Buffer[] = [];
	for (const c of central) {
		const h = Buffer.alloc(46);
		h.writeUInt32LE(0x02014b50, 0);
		h.writeUInt16LE(c.method, 10);
		h.writeUInt32LE(c.compLen, 20);
		h.writeUInt32LE(c.rawLen, 24);
		h.writeUInt16LE(c.nameBuf.length, 28);
		h.writeUInt32LE(c.offset, 42);
		cdChunks.push(h, c.nameBuf);
		offset += 46 + c.nameBuf.length;
	}
	const cdSize = offset - cdStart;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(central.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdStart, 16);
	return Buffer.concat([...chunks, ...cdChunks, eocd]);
}

const DOC_XML =
	'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
	"<w:p><w:r><w:t>你好，世界</w:t></w:r></w:p>" +
	"<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>&amp;B</w:t></w:r></w:p><w:p/></w:body></w:document>";

describe("isOfficeFile", () => {
	it("只认 docx/xlsx/xlsm（大小写不敏感），老格式与 csv 不认", () => {
		expect(isOfficeFile("报告.DOCX")).toBe(true);
		expect(isOfficeFile("表.xlsx")).toBe(true);
		expect(isOfficeFile("宏.xlsm")).toBe(true);
		expect(isOfficeFile("老.doc")).toBe(false);
		expect(isOfficeFile("老.xls")).toBe(false);
		expect(isOfficeFile("a.csv")).toBe(false);
		expect(isOfficeFile("a.txt")).toBe(false);
	});
});

describe("parseDocxParagraphs", () => {
	it("段落 + 实体解码", () => {
		const paras = parseDocxParagraphs(makeZip([{ name: "word/document.xml", data: DOC_XML }]));
		expect(paras[0]).toBe("你好，世界");
		expect(paras[1]).toBe("A&B");
	});
	it("缺 document.xml 抛错（调用方回落二进制分支）", () => {
		expect(() => parseDocxParagraphs(makeZip([{ name: "other.xml", data: "x" }]))).toThrow();
	});
});

describe("parseXlsxSheets", () => {
	const ss =
		'<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		"<si><t>姓名</t></si><si><t>年龄</t></si></sst>";
	const sheet =
		'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
		'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
		'<row r="2"><c r="A2" t="inlineStr"><is><t>张三</t></is></c><c r="B2"><v>30</v></c></row>' +
		"</sheetData></worksheet>";
	// 真文件（openpyxl/Excel）rels Target 是绝对路径 /xl/…，相对路径也要能解
	it.each(["worksheets/sheet1.xml", "/xl/worksheets/sheet1.xml"])("Target=%s 都能定位 sheet", (target) => {
		const wb =
			'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
			'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
			'<sheet name="人员" sheetId="1" r:id="rId1"/></sheets></workbook>';
		const rels =
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			`<Relationship Id="rId1" Type="x" Target="${target}"/></Relationships>`;
		const sheets = parseXlsxSheets(
			makeZip([
				{ name: "xl/workbook.xml", data: wb },
				{ name: "xl/_rels/workbook.xml.rels", data: rels },
				{ name: "xl/sharedStrings.xml", data: ss },
				{ name: "xl/worksheets/sheet1.xml", data: sheet },
			]),
		);
		expect(sheets[0].name).toBe("人员");
		expect(sheets[0].rows).toEqual([
			["姓名", "年龄"],
			["张三", "30"],
		]);
	});
	it("无 workbook 回落 Sheet1 + stored 压缩", () => {
		const sheets = parseXlsxSheets(makeZip([{ name: "xl/worksheets/sheet1.xml", data: sheet, method: 0 }]));
		expect(sheets[0].name).toBe("Sheet1");
		expect(sheets[0].rows[1][0]).toBe("张三");
	});
});

describe("extractOfficeText", () => {
	it("非 office 扩展名回 null", () => {
		expect(extractOfficeText("a.txt", Buffer.from("hi"))).toBeNull();
		expect(extractOfficeText("a.csv", Buffer.from("a,b"))).toBeNull();
	});
	it("docx 出段落文本", () => {
		const r = extractOfficeText("报告.docx", makeZip([{ name: "word/document.xml", data: DOC_XML }]));
		expect(r?.text).toContain("你好，世界");
		expect(r?.truncated).toBe(false);
	});
	it("xlsx 出 Markdown 表格", () => {
		const sheet =
			'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1"><c r="A1" t="inlineStr"><is><t>品</t></is></c></row>' +
			'<row r="2"><c r="A2"><v>10</v></c></row></sheetData></worksheet>';
		const r = extractOfficeText("表.xlsx", makeZip([{ name: "xl/worksheets/sheet1.xml", data: sheet }]));
		// 表头是合成的 A 列标（不拿第一行数据冒充），数据行原样在下面
		expect(r?.text).toContain("| A |");
		expect(r?.text).toContain("| 品 |");
		expect(r?.text).toContain("| --- |");
	});
	it("坏 zip 抛错", () => {
		expect(() => extractOfficeText("坏.xlsx", Buffer.from("not a zip"))).toThrow();
	});
});
