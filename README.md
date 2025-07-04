# Markji MCP Server

一个用于与墨墨记忆卡（Markji）API 交互的 Model Context Protocol 服务器。

## 功能特性

这个 MCP 服务器提供了完整的墨墨记忆卡管理功能，包括：

### 核心工具

#### 📚 卡组和文件夹管理
- `listDecks` - 列出所有可用的卡组及其文件夹信息
- `listFolders` - 列出所有可用的文件夹
- `createDeck` - 在指定文件夹中创建新的卡组

#### 📖 章节管理
- `listChapters` - 列出指定卡组中的所有章节
- `addChapters` - 向卡组添加单个或多个章节

#### 🃏 卡片管理
- `addTextCards` - 添加文本卡片到指定卡组
  - 支持正面和背面内容
  - 支持批量添加
  - **新增**：支持指定章节添加（可选 `chapterId` 参数）
- `addImageCard` - 从 URL 添加图片卡片
  - 支持自动上传图片到墨墨服务器
  - 支持可选的图片说明
  - **新增**：支持指定章节添加（可选 `chapterId` 参数）
- **新增** `getCards` - 获取指定卡片的详细信息
- **新增** `updateCard` - 更新现有卡片内容
- **新增** `deleteCards` - 批量删除卡片
- **新增** `batchUpdateCards` - 批量更新多个卡片（优化版本）
- **新增** `batchAddCardsToChapters` - 批量向多个不同章节添加卡片

#### 🔄 卡片组织和移动
- `moveCardsToChapter` - 将卡片移动到指定章节（如果章节不存在会自动创建）
- `batchMoveCards` - 批量移动卡片到不同章节（高效的批量操作）

#### 🚀 高效批量操作
- `batchUpdateCards` - 批量更新多个卡片内容（使用优化的批量获取机制）
- `batchAddCardsToChapters` - 在一次调用中向多个不同章节批量添加卡片

### 🚀 性能优化特性

#### 高效的批量操作
- **并发 API 请求**：在 `listDecks` 中使用 `Promise.all` 并行获取数据
- **智能批量移动**：`batchMoveCards` 通过一次性获取章节信息并在本地处理映射关系，将多个移动操作的 API 调用次数降到最低
- **优化的批量更新**：`batchUpdateCards` 先批量获取所有卡片的 `grammar_version`，然后进行并发更新，API 调用次数减半
- **多章节批量添加**：`batchAddCardsToChapters` 支持在一次调用中向多个不同章节添加卡片，极大提升复杂内容导入效率
- **自动章节创建**：移动和批量操作会自动创建不存在的目标章节

#### 健壮的错误处理
- 每个工具都有完善的错误处理和详细的错误信息
- 批量操作提供详细的成功/失败报告
- 自动重试机制和优雅降级

## 安装和配置

### 环境要求
- Node.js 18+ 
- 墨墨记忆卡账户和 API Token

### 安装依赖
```bash
npm install
```

### 构建服务器
```bash
npm run build
```

### 配置
你需要设置 `MARKJI_TOKEN` 环境变量。

#### 在 Claude Desktop 中使用

配置文件位置：
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "markji-server": {
      "command": "node",
      "args": ["/path/to/markji-server/build/index.js"],
      "env": {
        "MARKJI_TOKEN": "你的墨墨API令牌"
      }
    }
  }
}
```

## 使用场景示例

### 场景 1：快速创建学习卡组
```
1. 调用 listFolders() 选择文件夹
2. 调用 createDeck() 创建新卡组
3. 调用 addChapters() 添加多个主题章节
4. 调用 addTextCards() 向特定章节添加卡片
```

### 场景 2：整理现有卡组
```
1. 调用 listChapters() 查看当前章节结构
2. 调用 batchMoveCards() 一次性重组多个卡片到新章节
3. 调用 deleteCards() 清理不需要的卡片
```

### 场景 3：导入学习资料
```
1. 使用 addTextCards() 批量导入文本内容
2. 使用 addImageCard() 添加图表和图片
3. 使用 moveCardsToChapter() 按主题整理
```

### 场景 4：复杂内容的高效导入（新功能）
```
1. 使用 batchAddCardsToChapters() 一次性向多个章节添加不同类型的卡片
2. 使用 batchUpdateCards() 高效地批量更新已有卡片内容
3. 极大提升大量内容导入和更新的效率
```

## 开发

### 开发模式（自动重构建）
```bash
npm run watch
```

### 调试
使用 MCP Inspector 进行调试：
```bash
npm run inspector
```

Inspector 将提供一个浏览器 URL 来访问调试工具。

## API 兼容性

本服务器与墨墨记忆卡官方 API v1 兼容，支持：
- 卡组和章节管理
- 文本和图片卡片创建
- 卡片更新和删除
- 文件上传和管理

## 版本历史

### v1.2.0 (最新)
- ✨ 新增：`batchAddCardsToChapters` 工具 - 支持在一次调用中向多个不同章节批量添加卡片
- ⚡ 优化：`batchUpdateCards` 工具 - 使用批量获取机制，API 调用次数减半
- ⚡ 新增：`batchGetCardDetails` 内部函数 - 提供高效的批量卡片详情获取
- 🚀 性能：显著提升复杂内容导入和批量更新的效率

### v1.1.0
- ✨ 新增：支持向指定章节添加卡片
- ✨ 新增：`getCards` 工具获取卡片详细信息
- ✨ 新增：`updateCard` 工具更新现有卡片
- ✨ 新增：`deleteCards` 工具批量删除卡片
- 🔧 改进：保留 grammar_version 以确保更新兼容性
- 📚 改进：更完善的错误处理和用户体验

### v1.0.0
- 🎉 初始版本
- 基础的卡组、章节、卡片管理功能
- 批量操作支持

## 许可证

MIT License
