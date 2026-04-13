# GeoTIFF Debug Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个独立单文件 `HTML` 调试页，验证本地 `GeoTIFF` 上传后是否能完成读取、元信息解析和 Canvas 预览渲染。

**Architecture:** 使用原生 `HTML + JavaScript` 页面，通过本地 `geotiff/dist-browser/geotiff.js` 读取文件；页面直接显示阶段日志、元信息和降采样预览，不依赖现有 React/OpenLayers 主链路。

**Tech Stack:** HTML, Vanilla JavaScript, Canvas, FileReader, geotiff.js browser bundle

---

### Task 1: 搭建独立调试页面骨架

**Files:**
- Create: `debug-geotiff.html`

- [ ] **Step 1: 写页面骨架**
- [ ] **Step 2: 放入文件上传、状态、日志、元信息和预览区域**
- [ ] **Step 3: 引入本地 `geotiff` 浏览器包**

### Task 2: 接入读取和元信息解析

**Files:**
- Modify: `debug-geotiff.html`

- [ ] **Step 1: 用 `FileReader` 读取本地文件并记录进度**
- [ ] **Step 2: 用 `GeoTIFF.fromArrayBuffer()` 和 `getImage()` 提取元信息**
- [ ] **Step 3: 在页面展示宽高、CRS、bbox、像元大小和波段数**

### Task 3: 生成缩略预览并输出错误信息

**Files:**
- Modify: `debug-geotiff.html`

- [ ] **Step 1: 对原始影像做降采样读取**
- [ ] **Step 2: 转成 RGBA 写入 `Canvas`**
- [ ] **Step 3: 对失败阶段打印明确错误信息**

### Task 4: 自检

**Files:**
- Verify: `debug-geotiff.html`

- [ ] **Step 1: 检查页面引用路径**
- [ ] **Step 2: 运行现有项目测试和构建，确认未受影响**
