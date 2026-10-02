# Office 预览 📄

pi-web-ui 插件：在 📄 视图里预览工作区的 Word / Excel / CSV 文件，AI 也能直接读。

## 功能

- 左栏列出工作区里的 `.docx` / `.xlsx` / `.xlsm` / `.csv`（最多 500 个）
- Word 显示段落，Excel / CSV 显示表格（首屏 200 行 × 20 列，超出截断提示）
- 本地文件不用进工作区：右边「本地文件」直接上传解析（只读，不存盘）
- 「复制文本」一键复制全文；「发给 AI」把内容塞进输入框草稿并切回聊天
- AI 工具 `office_read({ path })`：agent 可自己读工作区文档（设置 → 工具里可开关）

## 安装

```bash
# 方式一：复制到数据目录（立即生效，刷新页面即出现 📄 tab）
cp -r plugins/office-preview ~/.pi-web/plugins/office-preview

# 方式二：走 CLI 从仓库装
pi-web-ui install xing-shuyin/pi-web-ui/plugins/office-preview
```

删掉目录即卸载。

## 实现说明

零依赖。docx / xlsx 本质是 zip 包，服务端用 `node:zlib` + 手写 zip
中央目录解析做最小解包（stored / deflate），XML 用正则提文本：

- docx：`word/document.xml` 的 `<w:p>` / `<w:t>` 提段落
- xlsx：`xl/sharedStrings.xml` + `xl/worksheets/sheet*.xml` 提单元格
  （共享字符串、内联字符串、布尔、数值；公式取缓存值不求值），
  sheet 名按 `xl/workbook.xml` 还原
- csv：基础引号处理（`""` 转义），BOM 自动去掉

限制：单个文件 15 MB；文本预览 2 万字符；表格首屏 200×20。
不支持老格式 `.doc` / `.xls`（那是 OLE 二进制，不是 zip）——先另存为新格式。
