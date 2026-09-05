<div align="center">

# OpenTakeoff

> **One-Click Area is temporarily gated.** The flood engine is being re-validated against a wider plan corpus. Until that finishes the One-Click tool is off the canvas rail (`O` reports the gate) and the `one_click` / `detect_rooms` MCP verbs are **not registered** (a default build ships 45 tools). Trace rooms with **Area** (`A`) in the canvas and `measure_polygon` over MCP; every other tool, sweep and derivation is unchanged. A build lifts the gate with `VITE_ONE_CLICK=1` (canvas) / `OPENTAKEOFF_ONE_CLICK=1` (server). Sections and videos below that show One-Click describe the engine as it returns — see [`docs/design/ONE_CLICK_GATE.md`](docs/design/ONE_CLICK_GATE.md).

**建筑图纸的测量引擎 —— 造得让 AI 智能体能驱动，也让估算员愿意用。**

算量（takeoff）就是从建筑图纸上量出工程量的过程。OpenTakeoff 用同一个引擎做了两件事：
**40 个 MCP 工具**供智能体调用，一块浏览器画布供人使用。同样的漫水填充、同样的比例门槛、
同样的算法、同样的记录。每一次测量都存着它的**比例**、它的**方法**，以及**是谁做的** ——
这正是让结果可审计的原因，也是让它成为训练数据的原因。

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/demo-opentakeoff.kentucky--ai.com-2ea44f.svg)](https://opentakeoff.kentucky-ai.com)
[![MCP registry](https://img.shields.io/badge/MCP-io.github.Kentucky--ai%2Fopentakeoff-6f42c1.svg)](https://registry.modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/opentakeoff-mcp?label=opentakeoff-mcp)](https://www.npmjs.com/package/opentakeoff-mcp)
[![Benchmark](https://img.shields.io/badge/benchmark-OpenTakeoff%20Academy-orange.svg)](https://aec.kentucky-ai.com)
[![OpenArena](https://openarena.to/api/badge/cmsgykvsq0000mkuv7byhlgnl)](https://openarena.to/en/projects/cmsgykvsq0000mkuv7byhlgnl)
[![Sponsor](https://img.shields.io/github/sponsors/Kentucky-ai?logo=githubsponsors&label=sponsor&color=EA4AAA)](https://github.com/sponsors/Kentucky-ai)

[**面向智能体**](#面向智能体--从这里开始) · [**打开画布**](https://opentakeoff.kentucky-ai.com) · [引擎的约定](#让它可被驱动的约定) · [面向画布前的人](#面向画布前的人) · [数据层](#数据层--这个引擎存在的理由) · [研究项目](#研究项目) · [Fork 它](#fork-它) · [参与贡献](#参与贡献)

**两份手册：** [智能体手册](docs/AGENT_GUIDE.md) · [用户手册](docs/USER_GUIDE.md)

**其他语言 / Read this in:** [English](README.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

**看视频：** [一个自主智能体全程无剪辑完成一次算量（2:47）](https://youtu.be/e--kXxSGv7Y) · [医院装修图 → 一分钟内出报表（1:14）](https://youtu.be/cNDpPkTLY1k) · [画布走一遍（1:10）](https://youtu.be/aHiW8H2TSBs) · [One-Click Area（0:51）](https://youtu.be/YIjWZ-BAhLE)

<br/>

<img src="docs/img/social-card.png" alt="OpenTakeoff —— 在真实楼地面装修图上做算量，人和通过 MCP 接入的 AI 智能体以同样的方式驱动，每次测量的比例和来源都被记录" width="820"/>

</div>

---

## 从这里开始

| 你是 | 去这里 |
|---|---|
| **手上有标要投的估算员** | [打开画布](https://opentakeoff.kentucky-ai.com) —— 把图纸拖进去，无需账号，不上传任何东西。[**用户手册**](docs/USER_GUIDE.md)能带你在五分钟内从空白页走到导出算量，它的[工作顺序](docs/USER_GUIDE.md#the-working-order-on-a-real-bid)就是在真实标书上该走的顺序。 |
| **一个 AI 智能体**（或者接线的人） | `npx -y opentakeoff-mcp`，然后看[**智能体手册**](docs/AGENT_GUIDE.md)：操作模型、每次算量都要走到的标准收尾、引擎拒绝瞎猜的地方,以及为什么。逐工具的参考在 [`mcp/README.md`](mcp/README.md)。 |
| **在这个引擎上开发的工程师** | [`AGENTS.md`](AGENTS.md) 是仓库地图和上线纪律；[`FEATURES.md`](FEATURES.md) 把每项能力都对应到实现它的代码。 |
| **想要自己一份副本的团队** | [**Fork 它**](#fork-它) —— 几分钟内在自己的 URL 上跑起自己的实例，Apache-2.0 协议，什么都不会往外发。要提 PR 也是同一条路。 |

### Windows、macOS、Linux —— 全平台

OpenTakeoff 是**纯客户端的浏览器应用**，所以这块画布在 Windows、macOS、ChromeOS 和 Linux 上，
在任何当前版本的 Chrome、Edge、Firefox 或 Safari 里跑起来都一样。什么都不用装，什么都不上传，
也没有哪个功能是被操作系统锁住的。

- **快捷键会认平台。** 应用会按你面前的键盘标注修饰键 —— Windows 和 Linux 上是 `Ctrl` / `Alt` /
  `Shift`，Mac 上是 `⌘` / `⌥` / `⇧` —— 而处理逻辑一直把 `⌘` 和 `Ctrl` 当成同一个键。在画布里按
  `?` 就能看到当前的清单。
- **MCP 服务器在 Windows 上有测试。** `npx -y opentakeoff-mcp` 在 Windows、macOS 和 Linux 上都能跑，
  而且 CI 在每次改动时都会在 `windows-latest` 和 `ubuntu-latest` 上跑完整的 MCP 测试套件 ——
  类型检查、测试、构建，以及打包后的冒烟测试。
- **可选的附加组件。** 内置的[捕获服务器](capture/)是标准库 Python 3 写的，Python 能跑的地方它就能
  跑 —— 在 Windows 上用 `python capture\capture_server.py selftest`（或者 `py` 启动器）而不是
  `python3` 来调用。用画布既不需要它，也不需要可选的 [`server/`](server/) AI 沙箱。
- **锁死配置的企业机群**（MSIX 打包、Windows Sandbox、Intune 静默部署）跟踪在
  [#226](https://github.com/Kentucky-ai/opentakeoff/issues/226) 里，目前还没做。

## 这是什么

从图纸上量出工程量是每一份施工投标的输入 —— 多少地面、多少墙面、多少个固定设备,按什么比例,
在哪张图纸上。这件事每天要发生成千上万次。在 OpenTakeoff 出现之前,**根本不存在开源的算量引擎**,
不管是基于网页的还是别的形式,更没有任何自主智能体能调用的东西。

OpenTakeoff 就是这个引擎,在同一套几何算法上跑着两个前端:

- **一个 stdio MCP 服务器** —— `npx -y opentakeoff-mcp`,<!--tool-count-->47<!--/tool-count--> 个工具,
  在 [MCP 官方注册表](https://registry.modelcontextprotocol.io)上。一个智能体打开图纸、读图签栏、
  设定比例、漫水填充房间、在渲染叠加图上核对自己的工作,然后交回一份标记好的图纸 PDF。
- **一块浏览器画布** —— 没有后端,没有账号,不上传。估算员把一套图纸拖进去描图,用的是
  One-Click 房间识别、CAD 填充图案、卷材接缝布局、材料采购清单和各种导出。

两者互不是对方的包装皮。MCP 服务器直接引入 `web/src/lib/{oneclick,sheets,geometry,totals}`,
所以智能体提交的图形和一只手在画布上提交的图形完全一致 —— 同样的漫水填充遮罩、同样的角点吸附、
同样的损耗算法、同样的拒绝提示。

**来源记录才是承重的那部分。** 每个图形都记录着它被测量时的比例、产生它的方法(矢量漫水、
栅格描图、手绘、智能体提议)、是否被人工修正过,以及机器最初画出的边界(在修正旁边原样保留)。
往下游看,这是一份 PM 能看懂的审计轨迹。往上游看,这是一对带标签的 *(几何 → 面层)* 数据 ——
算量模型此前从未在规模上拥有过的训练信号。这第二种用途不是副产品,详见
[数据层](#数据层--这个引擎存在的理由)。

## 最近上线的功能

- **拼接图纸** —— 一层楼被分接线切成几张图纸后合并成一个可操作的整体表面;一个跨越接线的房间
  会作为同一个图形描出来,One-Click 也不例外
  ([#161](https://github.com/Kentucky-ai/opentakeoff/issues/161))
- **PDF 图层角色** —— CAD 导出的图纸会*声明*自己每一笔是什么,所以 One-Click 读的是图层树而不是
  从填充图案里猜边界,画布上配套一个图层面板,并有语料库 IoU 打分
  ([#85](https://github.com/Kentucky-ai/opentakeoff/issues/85))
- **图纸关系图** —— 智能体问"134 号房间是什么面层,你怎么知道的",得到的是那一行明细表,
  外加每个单元格的引用出处,横跨续页、旋转过的表头,以及多栋楼的编号体系:
  `sheet_graph` / `resolve_tag` / `find_schedule`
  ([#87](https://github.com/Kentucky-ai/opentakeoff/issues/87))
- **卷材** —— 把一个做法设成宽幅卷材或片材,引擎会算出接缝:分幅、多卷拼接、按裁剪顺序
  按比例画在房间上的裁剪线、一张可拖动重排的按比例卷材图,以及和测量数量并排的订购码数
  ([#136](https://github.com/Kentucky-ai/opentakeoff/issues/136))
- **画布上的过渡条** —— Takeoffs 面板里的 **⟂ Transitions…** 从你已经测量过的房间推导出两种
  面层交接的那条线;`derive_transitions` 在 MCP 上做的是同一件事。漫水描出来的房间互不共边,
  所以实际存在的是两种含义不同的"临近":同一个开放空间内面层变化的地方作为对接缝提交,而
  隔着一道隔断相邻的房间会被**作为问题保留、不计入数量** —— 那条过渡线其实是门洞里的门槛,
  而任何描图记录都没说门洞在哪儿。把两个房间共享的 34 LF 墙体直接算成 34 LF 门槛,会是一份
  带着机器自信的错误报价 ([#202](https://github.com/Kentucky-ai/opentakeoff/issues/202))
- **`symbol_sweep`** —— 从一个圈选样本出发,扫出一个重复符号的每一处实例,跨图纸比例只按
  *声明过*的比例换算,绝不自己去搜比例
- **`mark_verdict` / `delete_verdict`** —— 智能体用石墨色的 `AGENT` 菱形给自己的工作签字;
  只有人手才能盖上绿色的 `APPROVED` 印章
- **One-Click 精度提升** —— 来自 [RFC #60](https://github.com/Kentucky-ai/opentakeoff/issues/60)
  的边界提取和间隙容差(由 [@knmurphy](https://github.com/knmurphy) 贡献)、被更粗的墙体压过的
  细线笔画归类为标注而不是边界,以及内开门的扇形取在门扇后面而不是弧线本身
- **语音算量** —— 按住 `M` 说"carpet one, waste seven";识别用的是运行在 WebAssembly 里的
  whisper-tiny.en,在你自己的机器上跑,音频从不离开浏览器([docs/VOICE.md](docs/VOICE.md))

完整历史见 [CHANGELOG.md](CHANGELOG.md);每项能力对应的代码见 [FEATURES.md](FEATURES.md)

---

## 面向智能体 —— 从这里开始

把任意 stdio MCP 客户端指向已发布的包。Node 20+,不用克隆,不用构建:

```json
{
  "mcpServers": {
    "opentakeoff": {
      "command": "npx",
      "args": ["-y", "opentakeoff-mcp"]
    }
  }
}
```

如果你有 GitHub 身份,也 [fork 这个仓库](https://github.com/Kentucky-ai/opentakeoff/fork):
你对引擎做的改动就在那里被测试 —— 来自 fork 的每个 pull request 都会用只读 token 跑完整 CI ——
而经过测试的、来自智能体的 pull request 和其他任何人的一样按同一标准合并。
[贡献者路径](#fork-它)是同一条。

Claude Code:`claude mcp add opentakeoff -- npx -y opentakeoff-mcp`。Claude Desktop 用户可以
双击[最新发布](https://github.com/Kentucky-ai/opentakeoff/releases)里的 `opentakeoff-mcp.mcpb`
包 —— 它故意排除了可选的原生画布,这样每个 JSON 工具在任何地方都能用,渲染相关的接口
(`view_sheet`、图纸图像资源)会在跑不起来的地方准确说明缺了什么。Docker 和本地克隆两种方式
都支持,见 [`mcp/README.md`](mcp/README.md)。

<img src="docs/img/mcp-live-demo.gif" alt="真实的一次运行,3 倍速实时:一个终端里的 AI 智能体通过 MCP 对一家退伍军人医疗中心装修图上的三个病房做 One-Click;每次导出都会作为虚线铅笔提议落到网页应用里,操作员接受它们 —— 743.64 SF,从铅笔变成墨迹" width="900"/>

*真实的一次运行(3 倍速):智能体在一张联邦机构的装修图上对 161–163 号病房做算量,每次提交后导出。
每个图形落到应用里都是一个虚线的**铅笔提议**,只有操作员点了 Accept 才会变成墨迹。*完整、无剪辑的
全程录像在 [YouTube(2:47)](https://youtu.be/e--kXxSGv7Y)。

### 工具

| 分组 | 工具 |
|---|---|
| **打开与定位** | `load_plan` · `sheet_info` · `sheet_context` · `get_sheet_vectors` · `read_sheet_text` · `find_text` · `view_sheet` |
| **比例** | `set_scale` |
| **测量** | `one_click` · `detect_rooms` · `measure_polygon` · `cut_out` · `measure_line` · `measure_surface` · `place_count` |
| **重复与推导** | `symbol_sweep` · `sweep_schedule_row` · `derive_base` · `derive_transitions` · `apply_rules` |
| **读懂整套图纸** | `sheet_graph` · `resolve_tag` · `find_schedule` |
| **编辑与审计** | `list_shapes` · `edit_shape` · `edit_condition` · `edit_materials` · `duplicate_condition` · `split_condition` · `delete_shape` · `undo_last` |
| **标注与签字** | `annotate` · `list_annotations` · `link_annotation` · `mark_verdict` · `delete_verdict` |
| **提问** | `create_rfi` · `list_rfis` · `resolve_rfi` · `delete_rfi` |
| **交付** | `takeoff_summary` · `export_takeoff` · `export_report` · `export_marked_pdf` · `export_dxf` · `import_takeoff` |

再加上可浏览的图纸资源(`takeoff://sheets`),让智能体不只是操作这套工作图纸,还能"看见"它。
多文档会话是一等公民:一套标书是图纸**加上**明细表**加上**补充文件,`load_plan --merge`
在不打乱已有比例、做法或图形的情况下加入一份文档 —— 图纸关系图随后横跨整套文件,所以一份文件里的
房间标签能解析到另一份文件里的明细表行。`edit_condition` 能改到损耗率、×N 倍数和 `roll_setup`,
所以智能体的算量结果不会出现净量等于毛量的情况。

**智能体的手册是 [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md)** —— 是估算员那份手册的对应版本:
六条事实说清楚的操作模型、每次算量都要走到的标准收尾、"保留即是答案"的原则、哪些事没有智能体可调用
的动作以及为什么,还有一张"从拒绝到下一步"的对照表。逐工具参考见 [`mcp/README.md`](mcp/README.md)。
同一套内容用散文讲一遍,并深入讲图纸关系图和扫描行为的是 [`docs/MCP.md`](docs/MCP.md)。

### 让它可被驱动的约定

大多数测量类 API 对智能体是不友好的,因为它们放任智能体"自信地犯错"。以下是让这套引擎能放心
交给一个模型的规则,以及每一条存在的原因:

1. **一个坐标系,处处声明。** 渲染比例 2.0 下的图像像素 —— PDF 点数 × 2,原点在左上角,y 轴向下,
   这是浏览器画布的原生空间。每份图纸数据都同时携带 px 和 pt 两种单位的尺寸。没有哪个工具要求
   传入一个只能靠猜的单位坐标。
2. **比例是一道门槛,不是一个默认值。** 图上标注的比例只会被*读出来*,从不会被静默套用;
   采用它必须是一次显式的 `set_scale`。测量一张没有设定比例的图纸会被拒绝。像素 × 一个错误的
   比例²,会让每一个数字同时全错,所以引擎宁可停下也不去猜。测量区域内出现互相矛盾的比例标注
   会给出警告,而不是静默地挑一个。
3. **引擎负责描图,模型不能凭空造型。** `one_click` 返回的是墙体网络从你指定的种子点算出的那个环。
   模型没法交回一个自己想象出来的多边形并让它被计数。
4. **每条记录都带着它是怎么产生的。** 方法、种子点、是否启用了填充图案过滤、是否来自扫描像素、
   置信度因子,以及如果之后被人工移动过,机器最初画出的那个环。
5. **智能体的成果是铅笔稿,直到有人给它上墨。** 导出的内容落到画布里是虚线提议。`mark_verdict`
   让智能体用石墨色的 `AGENT` 菱形给自己的工作签字;绿色的 `APPROVED` 印章只有一条代码路径,
   就是工具栏那个按钮,在一只人手之下。没有哪个 MCP 调用、哪次导入能盖上它。
6. **交付物是一份标记好的图纸,不是一堆 JSON。** `export_marked_pdf` 把工作成果按实际绘制方式
   烧录进图纸 —— 做法颜色、填充图案、数量标签、计数标记 —— 前面还有一页带总量的图例封面,
   以及一份"这套图纸里到底有多少被人实际复核过"的统计。一份没人能核对的算量,不算算量。
7. **拒绝也是可以行动的字符串。** "那块区域在图纸线条上没有封闭 —— 填充溢出了",这句话告诉模型
   接下来该做什么。一个沉默的零做不到这一点。答不上来的工具会带着明确理由拒绝,而不是回一个
   看起来说得过去的数字。

### 验证你的实力 —— OpenTakeoff Academy

[**aec.kentucky-ai.com**](https://aec.kentucky-ai.com) 是一个独立的开放基准测试和认证竞技场,
面向会做算量的智能体。带上任意模型和你自己的执行框架;评分依据是**在你不掌控的几何图形上操作
一个真实的算量工具** —— 标定错了,面积就错了 —— 而不是靠吐出一个"看起来说得过去"的数字。
每次运行都会输出一份带签名的记录包,包含每次工具调用的完整来源;评分对照的是留出的真值和一个
人类高级估算员的基线,通过一个等级会得到一份可独立验证的资质证书。Certified 级别在任务工具背后
驱动的正是这个引擎(`opentakeoff-mcp`)。仓库:
[Kentucky-ai/opentakeoff-academy](https://github.com/Kentucky-ai/opentakeoff-academy)。

---

## 面向画布前的人

智能体这条路之所以存在,是因为人这条路本来就是真的。下面的一切都是从一套商用九分部
(Division 9)估算系统里剥出来的生产级测量引擎 —— 不是重新做的演示版。

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

或者打开[**在线演示**](https://opentakeoff.kentucky-ai.com)。把 `demo/sample-plan.pdf` 拖进去,
接受检测到的比例,选一个做法,点 **One-Click Area**,然后在房间内部点一下。打开 **Report** 看明细
和导出。整个流程的视频:[画布走一遍(1:10)](https://youtu.be/aHiW8H2TSBs) ·
[One-Click Area(0:51)](https://youtu.be/YIjWZ-BAhLE)。从零到导出的完整走法在
[**用户手册**](docs/USER_GUIDE.md)里。

**一份真实标书在它上面是什么样子**,按估算员实际工作的顺序:

1. 把投标平台上下载的整个 `.zip` 拖进去 —— 图纸、明细表、补充文件。
2. 给你要测量的每张图纸设定比例,并在每张图上**核对一个尺寸**(`K`)。每张图十秒钟,而这是
   唯一一个会一次性错掉所有数字的失误。
3. 从建筑师的明细表里拉出你的做法,而不是手打,并在描图**之前**设好损耗和材料。
4. 拼接任何在接线处被切开的部分,对齐它,然后才开始测量。
5. 逐个房间做 **One-Click**。从刚测量过的房间上推导踢脚和过渡条,而不是再测一遍 —— 并且
   要读懂推导结果里*报告但从不计数*的部分,因为那些是你还欠着的门洞门槛。
6. 走一遍整套图纸,看看落下的是什么,用控制点修正,存一个**版本**。
7. 两样都导出:给报价用的 Report,给审核你的人用的**标记图纸** PDF。

那套流程的完整版本,每一步对应到手册的哪一节,在手册的
[工作顺序](docs/USER_GUIDE.md#the-working-order-on-a-real-bid)里。上面每个术语的意思在它的
[术语表](docs/USER_GUIDE.md#18-glossary--what-the-words-mean-here)里。

### 打开任何文件,秒开
一份图纸 **PDF**、一张**图片**(扫描件、截图、照片),或者整个直接来自投标平台的 **`.zip`
图纸包**。压缩包在*你的浏览器里*被解开,图片被包成 PDF —— 支持多页、多文件,最多**并排 4 张
图纸**,还有防恶意压缩包的保护,一个畸形 zip 会干净地失败,而不是把标签页撑爆。没有上传步骤,
没有转换服务,不需要账号。

### 真正的测量引擎
**One-Click Area** 是主打功能:在房间内部点一下,图纸线条框定一次漫水填充,多边形自己描出来,
顶点吸附到真实角点上。**填充图案和乱线糊弄不了它** —— 瓷砖网格、木地板拼缝线、剖面填充都会被
归类为图案而不是墙体,而且这套升级判断足够保守,误判的结果永远不会比严格漫水填充更差。**扫描件
也能用**:没有矢量线条时引擎读渲染出来的像素 —— 自适应阈值、蓝图负片的极性检测、给褪色墨线用的
间隙桥接 —— 并给结果打上标记,让你在提交之前核对边缘。在发布了图层树的 CAD 导出图纸上,One-Click
读的是声明过的角色,而不是靠推断。

再加上完整的手动工具箱 —— **面积、矩形、长度、曲线长度、墙面面积(Surface Area)、计数**,以及
做扣减的 **Cut Out** —— 还有一个不影响算量结果、只回答"这个分区里有什么"的**分区核对**。

**⟂ Transitions** 从你已经测量过的房间推导出两种面层交接的那条线。同一个开放空间内的面层变化
会作为一段虚线对接缝提交,你确认即可;隔墙相邻的房间会被**报告但从不计数**,因为那条过渡线其实
是门洞里的门槛,没有任何描图能定位它 —— 你会拿到它的长度、墙体厚度,以及一个能把它显示在屏幕上
的链接。

<div align="center">
<img src="docs/img/one-click-area.gif" alt="真实装修图上的 One-Click Area:在一间病房内部点一下,整个房间就沿墙自动描出轮廓 —— 240.7 SF,按 Enter 提交" width="820"/>
</div>

### 名副其实的绘图辅助
**45°/90° 角度锁定**:接近水平、垂直或对角线几度以内时,线段就锁到那条轴上 —— 提交的点是
*精确*落在轴上的点,所以墙体量出来是方正的(按住 `⇧` 可以在任意角度强制锁定)。在画布上,
十字光标**就是**光标本身 —— 系统指针被隐藏,一颗星标出交叉点,进行中的工作用仪器专属的钴蓝色
绘制,已提交的图形则穿上它做法的颜色。锁定的反馈是安静的 —— 星标会变大,预览线变粗,一个小标签
显示锁定角度和实时线段长度。**Snap**(beta)会吸附到真实的 PDF 端点,角点优先于轴线。

### 贴合真实图纸的比例处理
自动识别图上标注的比例,或者从任意已知尺寸**标定**。比例是**按每张图纸单独记住**的,因为一套
图纸从来不是统一比例,假定它是的工具会把数字算错。**核对尺寸**(`K`)是标定的只读孪生功能:
挑一处印刷的尺寸标注,输入图上写的数值,得到一个分级判定(1% 以内为绿色,5% 以内为琥珀色,
超过则为红色),再加一键**按此重新标定**。每次接受比例都会在图纸上留下一条短暂出现的标定标尺,
所以比例差了一倍这种事在开始描图之前就一目了然。英制或公制(m²/m、1:50 这类比例)只是一个显示
开关 —— 算量结果本身与单位无关地存储,切换它永远不会改动任何一个测量值。

### 做法、材料与采购清单
一个**做法**就是一种面层(LVP、地毯、瓷砖、踢脚……),带着线条/填充颜色、一种 **CAD 填充图案**
(让画布看起来和真实图纸一样)、按做法设置的**损耗率**、一个 **×N 倍数**、一个默认的墙体**高度**,
以及一个能把线性长度折算成边界面积的**厚度**。**从明细表导入**会把建筑师明细表里的内容解析成
做法,经过一个核对对话框 —— 你确认哪些变成做法,产品规格作为只读的报表列跟着一起走。

**辅材(Supporting Materials)**是大多数算量工具懒得做的那一层:按做法设置施工工艺类型和基层类型,
再加上实际会出现在订单上的消耗品 —— 胶粘剂、封闭底漆、薄贴砂浆、填缝剂、踢脚胶 —— 每一种都有
自己的**覆盖率**和一个**基准**(地面 SF / 线性 LF / 每件 / **算好的接缝 LF**)。订购数量自动推导:
测量值 ÷ 覆盖率,**向上取整**到整数单位。胶粘剂和砂浆行有预设覆盖率;填缝剂行有一个计算器,
能从瓷砖尺寸、厚度、缝宽和袋重推出 SF/袋。预设值是行业常见的整数,**务必对照产品数据表核实**。

### 卷材 —— 算好接缝
把一个做法设成宽幅卷材或片材(材料类别、卷宽、最大卷长、接缝和墙面余量、方向、销售单位),
引擎会把裁剪方案排出来:分幅、接缝位置、多卷拼接,以及订购码数。裁剪线按比例、用材料对应的
真实颜色画在各自的房间上,按裁剪顺序编号,在一个纳入撤销栈的编辑模式里可以滑动或调整大小。
停靠的卷材面板会把这些裁剪按**卷材本身**嵌套展示,带尺寸和拖拽重排,而 **订购码数(Roll Order
LF)**、**卷数(Rolls)**和**接缝码数(Seam LF)**会和测量数量一起出现在报表、CSV 和 Excel 里。
接缝码数就是直接从那份布局里读出来的焊条/接缝带用量 —— 只在同一房间相邻两幅材料之间统计,
扣掉墙面余量,只算两幅确实相接的地方 —— 所以一条按**接缝 LF**基准计价的辅材行,算的是接缝真正
碰在一起的地方,而不是按周长的某个比例估的。一间宽 20 英尺、用 12 英尺宽卷材铺的房间,沿长度方向
接一次缝;同样面积但分成两间 10 英尺的房间则完全不接缝,而任何按面积算的系数都区分不出这两种
情况。这个功能通过 `edit_condition` 上的 `roll_setup` 也能无界面调用。(卷材布局引擎由
Michael Hartman 贡献。)

### 多图纸的现实
**拼接**:一层楼被分接线切成几张图纸后,合并成一个可操作的整体表面 —— 在两张图纸上各选同一个
绘制点来对齐接缝,然后就能直接跨接线描图。**楼层(Levels)**用来给多层的整套图纸分组。可视化的
**图库**(`G`)是你选图、开图的地方,**Regroup** 一键恢复并排布局。一次描图不能横跨两张*被分组*的
图纸 —— 面板之间的间隙不是真实距离,所以提交会被拒绝,并提示你去拼接。

### 报表、导出与版本
按做法分列的明细 —— **地面/墙面/边界 SF、LF、EA、总 SF、SY**,含损耗和不含损耗两种 —— 加上一份
合并的**材料采购清单**。损耗只会体现在报表的订购数量里,从不改动实测数量本身,所以算量结果和
采购清单在这一点上都是诚实的。可以导出 **CSV**、**JSON**、真正的 **Excel 工作簿**(Summary /
By-sheet / Materials / Shapes-audit / **按楼层 × 房间**,全精度单元格,像公式的名称会保持为纯文本),
可以打印,也可以导出**标记版 PDF** —— 一份完全在你浏览器里生成、可以直接发给不会装任何软件的
总包的图纸。

补充文件到达时,**版本(Revisions)**让它变成数据而不是考古 —— 在每次标书修订时存一个命名版本,
然后把任意两个版本按做法、按图纸、按采购清单比出数量差,附一份比对 CSV。这个比对刻意停留在
数量层面而不是几何层面 —— 它告诉你哪些数字变了,不告诉你哪面墙变了。恢复操作会先把当前的算量
存一份,所以它从来不是单向门。

<div align="center">
<img src="docs/img/report.png" alt="OpenTakeoff 报表 —— 按做法分列的明细和材料采购清单" width="780"/>
</div>

### 批注、签章与 RFI
一个总量永远不会计入的独立图层:修订云线、引注、文字说明、荧光笔标记、**图片**(上传 PNG/JPEG,
或者圈选图纸上的一块区域把它作为浮动截图放回去 —— 可移动、可缩放,并会烧录进标记版图纸),
以及可复用的**图章**(铺装方向、接缝方向、图案起点 —— 自己建一个,或者导入一个 `.svg`)。
**批准签章**是估算员的墨迹:点一下一个已提交的算量结果就能批准它,标记版图纸的封面上会多一行
统计 —— *N 项估算员已批准 · N 项智能体标记*,让 PM 清楚知道这套图纸里到底有多少被人看过。
**RFI 登记簿**能把任何批注变成一个带状态、优先级、责任方和成本/工期影响标记的追踪问题,
可以导出为 CSV/JSON,也可以作为一页 RFI 明细表出现在标记版图纸里。

### 浏览器里的智能体面板
在画布里不用离开就能体验和 MCP 一样的"提议/复核"分工:用一句话描述一次算量,一个模型 ——
**你自己的**,用你自己的密钥,在你自己的浏览器里 —— 用应用自身的确定性工具跑这张图纸,
并暂存虚线提议供你接受、修正或拒绝。它不能凭空造出几何图形(`propose_shapes` 会拒绝任何
没有引用出处的东西),也不能设定比例。想在完全不接 AI 账号的情况下看这个循环怎么跑,可以运行
`scripts/` 里那个无需密钥的确定性模拟服务器。

### 矢量级清晰的画布
超过约 1.15 倍缩放**(乘以你显示器的像素比)**之后,可见区域会直接从 PDF 矢量重新渲染到当前缩放级别,
而不是放大一张固定的位图,所以细小的引注和填充图案永远不会糊 —— 而且它会在手势停顿之后才启用,
这样持续缩放的过程会一直留在快速的底图层上。它只叠加屏幕上看得见的部分,所以不需要保留一整张
图纸的位图。**深色视图**(☾)会反转图纸像素本身 —— 一张真正的负片,黑底白线,不是一层 CSS
滤镜 —— 填充图案也相应调整过,导出结果也遵循这个视图。

### 数据留在本地,归你自己
每一张图纸、每一个比例、每一个做法、每一条批注和每一份 RFI 都会自动保存到**你自己的浏览器**里
(IndexedDB + localStorage)。没有任何东西被上传,不需要账号,默认构建里也没有服务器。手册里说得
很直白:存储是按浏览器、按来源分开的,清空网站数据会清空你的工作。

<details>
<summary><strong>可选:团队云模式(Google 登录 + Drive)</strong></summary>

<br/>

以上一切都是默认状态,不会改变:打开页面,你就是一个匿名的、纯本地用户。一个 Google Workspace
团队可以*选择性地*登录来解锁一种共享模式:项目以文件夹形式存在团队自己的 Google **Drive**
里,项目列表从一个已有的 **Glide** 应用深链接过来,材料成本来自一份同步的 `pricing.json`。
这完全是叠加的功能 —— 什么都不设置它就不存在。安全姿态保持不变:仍然是一个纯静态站点,
**打包内不含任何密钥**,因为 Google OAuth 应用是**内部**的所以只对你的域名生效,数据存在
**你自己的 Drive** 里。参见 [`docs/GOOGLE_SETUP.md`](docs/GOOGLE_SETUP.md) 和
[`docs/GLIDE_INTEGRATION.md`](docs/GLIDE_INTEGRATION.md)。云端部署也可以选择启用
**本地优先同步**(`VITE_CLOUD_SYNC=1`):批注在浏览器里始终是权威数据,在后台同步到 Drive,
所以画布是即时响应的,网络不稳也能扛住 —— 见 [`docs/SYNC_ARCHITECTURE.md`](docs/SYNC_ARCHITECTURE.md)。

</details>

<details>
<summary><strong>可选:接入你自己的视觉模型</strong></summary>

<br/>

OpenTakeoff 可以请求一个**你自己**提供的视觉模型来读图纸上的信息 —— 首先是当图纸文字没有标注
比例时读出图上标的比例(扫描件、旋转过的标注、图片形式的图签栏)。点工具栏里的 **AI**,
指向一个 **OpenAI 风格**的接口(默认选项;你自己机器上的本地运行环境说的就是这套协议,不需要
密钥)或者一个 **Anthropic 风格**的接口,再加一个支持视觉的模型 id。

- **会发送什么,而且只在你点了 AI 按钮的时候才发送:**一张对应图纸区域的截图,加上问题 ——
  发到*你自己*的接口。绝不会发送整份图纸文件、文件名、项目名,或者你的算量结果。
- **什么都不配置 = 什么都不存在。**未配置的构建版本不会多出任何界面,也不会产生任何 AI 网络
  请求。不管有没有配置都没有遥测。
- 得到的答案永远只是一个**建议**,走的是和文字识别出的比例一样的"确认后采用"流程,接受时会
  显示标定过的参考标尺。
- 密钥存在这个浏览器的 localStorage 里 —— 用一个你能随时吊销的密钥。部署方:
  `VITE_AI_ENDPOINT` / `VITE_AI_MODEL` / `VITE_AI_PROVIDER` 可以固化团队默认值,但**绝不要在
  公开部署上设置 `VITE_AI_KEY`** —— Vite 会把它内联进发布出去的打包文件里。

</details>

## 功能一览

| 方面 | 你能得到什么 |
|---|---|
| **导入** | PDF、图片,或 `.zip` 图纸包 —— 在浏览器内解包,支持多页、多文件,最多并排 4 张图纸 |
| **比例** | 自动识别图上标注,从已知尺寸标定,或用分级核对来验证 —— 按每张图纸分别处理 |
| **测量** | One-Click Area(矢量漫水 + 栅格兜底)、面积、矩形、长度、曲线长度、墙面面积、计数、Cut Out 扣减、⟂ Transitions、分区核对 —— 英制或公制 |
| **绘图辅助** | 45°/90° 角度锁定,`⇧` 强制锁定,光标处实时显示角度和线段长度,端点 Snap(beta) |
| **做法** | 每种面层的颜色 + CAD 填充图案、损耗率、×N 倍数、墙体高度、边界厚度、明细表导入、跨浏览器的做法库 |
| **辅材** | 施工工艺 + 基层类型,覆盖率 × 基准(含算好的接缝 LF)→ 向上取整的订购数量,涂布器/滚筒预设,填缝剂计算器 |
| **卷材** | 按做法设置卷材参数 → 分幅、接缝、多卷拼接、可拖拽重排嵌套的按比例裁剪线,每次导出都带订购码数 + 卷数 + 算好的接缝码数 |
| **多图纸** | 图纸图库、标签页和并排分组、Regroup、楼层分组、**跨接线拼接**、PDF 图层角色 |
| **报表** | 按做法分列的地面/墙面/边界 SF、LF、EA、SY,含损耗和不含损耗,加上合并采购清单;列、分组、已保存的模板 |
| **导出** | CSV、JSON、**Excel(.xlsx)**、打印、**标记版 PDF**、RFI CSV/JSON |
| **版本** | 每次标书修订时保存,按做法/图纸/采购清单比对数量差,带保护的恢复功能 |
| **批注** | 云线、引注、文字说明、荧光笔、**图片**(上传或圈选截图)、图章、**批准签章**、RFI 登记簿 —— 独立图层,从不计入数量 |
| **语音** | 按住说话式的算量口令,设备端 WebAssembly 识别;音频从不离开浏览器 |
| **视图** | 浅色或**深色(负片)**——绘制时反转图纸像素,导出结果遵循 |
| **存储** | IndexedDB + localStorage —— 纯客户端,不上传任何东西 |
| **MCP 服务器** | <!--tool-count-->47<!--/tool-count--> 个工具 + 可通过 stdio 浏览的图纸资源,多文档会话([`mcp/`](mcp/README.md)) |
| **来源记录** | 每个图形都记录它的比例、方法、置信度,以及是人还是智能体做的 |
| **捕获(可选开启)** | 内置的[捕获服务器](capture/README.md)把每次贡献的算量存为(几何 → 标签)训练数据行 |
| **部署** | 一个静态构建产物 —— Netlify、Vercel、GitHub Pages、Cloudflare Pages、S3,任意静态主机 |

---

## 数据层 —— 这个引擎存在的理由

每一份做完的算量都是一组专家决策:*这块*区域用*这种*面层,损耗*这么多*,得到*这些*数量。做一次,
那是一份标书。每次都记录下来,那就是一个**目前根本不存在的带标签数据集**——图纸几何与专家为它
指定的面层配对,正是训练一个能做算量的模型所需的原始材料。而今天,数据一到标书发出去那一刻就
蒸发了。

这个论点摆出来是为了被人挑战的:**标注即标签。**专业算量软件本来就把每一片描出来的区域存成
矢量几何,重建那些多边形能精确复现记录下来的数量 —— 所以二十年的估算工作是一份精确、
*可验证*的语料库,而不是一份带噪声的语料库。这个论断正是整个研究项目在检验的东西,而且它
处于专利申请阶段。

OpenTakeoff 是产出这份语料库的工具,收集路径是选择性开启且可审计的:

- Report 里的**贡献(Contribute)**按钮会构建一份仅含派生数据的负载 —— 做法标签、图形角色、
  数量、相对图纸归一化到 0 到 1 的几何数据,以及每个图形的来源信息(是手工描的还是机器提议的,
  是否被人工修正过,连同机器最初画的那个环一起放在修正旁边)。这个构建器只有约 150 行经过审计
  的代码([`web/src/lib/contribute.js`](web/src/lib/contribute.js));规范性的传输协议在
  [`docs/CONTRIBUTION_SPEC.md`](docs/CONTRIBUTION_SPEC.md)里。
- **绝不发送**的内容,由构建器里的一份白名单强制执行:PDF 本身或它的任何渲染图、文件名或图纸名、
  项目/客户名、批注文字、绝对坐标、比例的*具体数值*(只发送比例的来源 —— 标定得到的、检测到的,
  还是标准值),以及创建时间戳之外的编辑时间信息。有一处关联是刻意保留且公开说明的:图形带着
  不透明的、本地生成的 ID,这样补充文件之后的重新贡献是覆盖而不是重复。
- 内置的**捕获服务器**([`capture/`](capture/README.md)) —— 一个只用标准库的 Python 文件,
  不需要 pip 安装 —— 在本机接收这份数据,为每个带标签的图形存一条训练数据行,按哈希去重,
  所以重复贡献不会产生重复数据。v2 数据行会区分机器做对了什么和专家不得不修正了什么,
  这才是真正能教会一个算量模型的信号。用 `--mirror` 指向一个已同步的文件夹,语料库就能原子性地
  搭上公司现有的存储同步。

```bash
python3 capture/capture_server.py    # 然后,在应用的浏览器控制台里执行:
# localStorage.opentakeoff_contribute_endpoint = "http://localhost:8787/contribute"
```

原样运行 OpenTakeoff,这一切对你来说都不存在 —— 不会采集任何东西,不会有任何东西离开你的机器。
装上它之后,你*选择*贡献的每一次算量都会累积成一份你自己拥有的资产。这是
[Spline](https://spline.quisutdeus.io) 里那层捕获能力的开放版本 —— Spline 是 OpenTakeoff
脱胎于其中的商用九分部估算系统,在那里捕获是在自动保存和提交时环境式运行的,而不是藏在一个按钮
后面。数据行的结构和训练思路在 [`capture/README.md`](capture/README.md) 里。

## 研究项目

OpenTakeoff 是一个应用研究项目的开放那一半,这个项目由一位在职的商用地面装修估算员运营,
他自己造他所在部门在用的 AI([Kentucky AI](https://kentucky-ai.com))。这条开放核心的边界,
和更优秀的开放科学软件所划的边界是同一条:**测量引擎 —— 渲染、比例、几何、导出、MCP
服务器 —— 是 Apache-2.0 协议,并持续保持开放。用我们自己的估算档案训练出来的模型是专有的。**
你得到一个不收席位费的真工具;只有我们的数据才能造出来的那部分,归我们所有。

研究这一侧按实验室的方式运营,而依据本身就是重点:

- **参数高效微调,不是预训练。**在开放权重底座模型上用 QLoRA 适配器(训练参数约占 0.1%),
  用经过验证的标书档案专门化 —— 便宜到数据说该重训就能重训,小到能直接发布。旗舰适配器在
  一个 51 个项目的时间性留出测试集上预测标书总价,**中位数绝对百分比误差为 12.3%**,
  未微调的底座模型是 **62.8%**;完整方法和诚实的注意事项见
  [模型卡](https://huggingface.co/Kentucky-ai/div9-flooring-estimator-gemma4-31b)。
- **进入训练的标签经过验证。**一份历史标书成为训练数据之前要过一道双文档验证关:总价必须在
  标书工作簿和另外单独归档的报价单之间对得上,变更单只有在被真实变更单文档印证时才计数,
  逐行的算式会被重新计算并核对。无法验证的项目不参与训练。
- **评分用的标尺可验证。**模型对照时间上留出的项目打分 —— 是未来的标书,而不是随机切分出来的
  —— 使用一个**自身误差下限已被测出(0.4%)**的几何评分器,这样一个数字能被归因到是模型的
  误差还是测量本身的误差。
- **多个随机种子复现。**没有哪个结果是靠单次训练就被采纳的;采纳需要用不同随机种子复现,
  并给出配对 bootstrap 置信区间,跨种子的离散程度会和最佳种子一起公开。
- **失败结果也保留。**实验记录会写下什么失败了、为什么失败 —— 一份毁掉检测效果的解冻方案,
  一个败给通用模型跨领域迁移能力的垂直专用模型 —— 和成功的结果放在一起。
- **发布前做过泄漏审计。**标识信息在训练*之前*就被替换掉,所以权重从没见过真实姓名,
  每一份公开的产物都要过一轮差分红队测试:用对抗性抽取探针攻击微调后的模型,以未微调的
  底座模型作为对照。

经过脱敏处理的产物 —— 模型卡、基准规范、论文 —— 会在通过审查后陆续发布:
[Hugging Face](https://huggingface.co/Kentucky-ai) ·
[kentucky-ai.com](https://kentucky-ai.com)。智能体侧的评测在
[OpenTakeoff Academy](https://aec.kentucky-ai.com)。

---

## 运行 / 部署

要使用它,你只需要一个浏览器。要自己部署,那是一个可以扔到任何地方的静态构建产物 ——
没有后端,没有数据库,不需要搭建任何环境。

```bash
cd web
npm install
npm run build      # → web/dist/  (静态文件;放到任何地方托管)
```

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Kentucky-ai/opentakeoff)

仓库根目录自带 `netlify.toml`,所以这个按钮真的是一键部署。同一份 `web/dist/` 在
**Vercel、GitHub Pages、Cloudflare Pages、S3** 上都能跑 —— 任何能提供静态文件服务的地方都行。
要跑自己的反向代理 —— nginx、Docker、Tailscale?先看看
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) —— 里面有一个值得知道的 MIME 类型坑。
部署细节和可选的 AI 后端见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## Fork 它

Apache-2.0:fork 它、改它、发布它 —— 给自己团队用,或者作为你自己产品的底座。fork 在这里既是
所有权的单位,也是贡献的单位:同样这三步,既能给你一个私有实例,也能给你一个可以送回来的分支。

1. **[在 GitHub 上 fork](https://github.com/Kentucky-ai/opentakeoff/fork)**,然后克隆你的 fork。
2. **跑起来:** `cd web && npm ci && npm run dev` —— 画布在 `localhost:5173`,`npm run check`
   就是 CI 用的那道门槛(类型检查、lint、测试、构建)。
3. **放到你自己的 URL 上:**仓库自带 [`netlify.toml`](netlify.toml)(base 是 `web`,publish 是
   `dist`),所以把你的 fork 导入 Netlify 不需要改任何设置就能部署;任何静态主机都可以,
   [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) 说明了那一个 nginx 的坑。你的实例和公开版本
   一样,把每张图纸都留在本地。

来自 fork 的 pull request 会用只读 token、不带任何密钥地跑完整 CI
([`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)),所以你 fork 上的绿勾在这里也是绿勾。这份代码库
刻意保持得小而易读,几何相关的库是纯函数,可以直接拿走用:

| 内容 | 位置 |
|---|---|
| 漫水填充、边界提取、角点吸附、栅格兜底 | [`web/src/lib/oneclick.ts`](web/src/lib/oneclick.ts) —— 纯 TS,有测试 |
| 比例检测、图纸辅助函数、多边形面积 | [`web/src/lib/sheets.ts`](web/src/lib/sheets.ts) —— 纯 TS,有测试 |
| 损耗、平方码换算、覆盖率 → 订购数量 | [`web/src/lib/totals.js`](web/src/lib/totals.js) |
| 卷材分幅与接缝布局 | [`web/src/lib/rollgoods.js`](web/src/lib/rollgoods.js) —— 纯函数,有测试 |
| 持久化(IndexedDB + localStorage) | [`web/src/lib/store.js`](web/src/lib/store.js) |
| PDF / 图片 / zip 导入 | [`web/src/lib/ingest.js`](web/src/lib/ingest.js) |
| 画布本体(一个大组件,占应用约 90%) | [`web/src/pages/TakeoffCanvas.jsx`](web/src/pages/TakeoffCanvas.jsx) |
| MCP 服务器(引入同一批库) | [`mcp/src/`](mcp/src/) |
| 设计令牌 —— 颜色和间距的唯一真源 | [`web/src/styles/tokens.css`](web/src/styles/tokens.css) |

第三方集成和下游 fork 今天就跑在这个引擎上。

`cd web && npm run check` 就是 CI 用的那道门槛 —— 类型检查、lint、测试、构建。让
`oneclick.ts` 和 `sheets.ts` 保持不含 React 和 DOM;正是这种纯粹性让它们可复用、可测试。
永远不要提交真实的施工图纸。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)
—— 仓库写给编码智能体自己的说明 —— 以及[用户手册](docs/USER_GUIDE.md)。

## 参与贡献

开放的工作是架构性的,以带明确完成线的 RFC 形式发布,而不是一份人为拼凑的杂务清单。
目前开放的:

- [**RFC #60** —— 把 One-Click Area 做到真正出色](https://github.com/Kentucky-ai/opentakeoff/issues/60):
  边界提取、间隙容差、置信度。已部分落地 —— 第一批改动在
  [#179](https://github.com/Kentucky-ai/opentakeoff/pull/179) 合并,由
  [@knmurphy](https://github.com/knmurphy) 贡献并在发布说明中致谢 —— 精度上限仍然是开放的。
- [**RFC #87** —— 图纸关系图](https://github.com/Kentucky-ai/opentakeoff/issues/87):
  把房间标签、明细表、图例和详图引注解析进一个可查询的图,每个答案都带引用出处。已上线两个阶段;
  修订云线和详图引注链条还开放着。
- 任何打了 [`rfc`](https://github.com/Kentucky-ai/opentakeoff/labels/rfc) 或
  [`flagship`](https://github.com/Kentucky-ai/opentakeoff/labels/flagship) 标签的 issue ——
  flagship 是一个开放的设计与实现挑战,欢迎多份方案,最好的那份会被合并并署名。
- 更小、说明完整的入口点打了
  [`good first issue`](https://github.com/Kentucky-ai/opentakeoff/labels/good%20first%20issue)
  标签 —— 它们指名了确切要改的文件。在评论里认领一个,开始就行。

基本规则在 [CONTRIBUTING.md](CONTRIBUTING.md) 里。门槛是一个绿色的 `npm run check`,加上任何
涉及几何库改动都要有测试;有测试的 PR 会很快合并。CI 还守着两条 `npm run check` 管不到的线:
文档里每一个相对链接和锚点都必须能解析(本地跑 `node scripts/check-doc-links.mjs` 可以自查),
以及 `web/bench/results.json` 必须和引擎实际产出的结果一致 —— 一次引擎改动要在同一个 PR 里
带上它的 bench 差值。外部贡献会在提交记录和发布说明里按姓名致谢 —— 而且因为 `opentakeoff-mcp`
是从 `mcp-v*` 标签发布到 npm 的,你落地的引擎改动会送到每一个拉取这个包的智能体手上。

发现了可利用的漏洞?通过
[私有漏洞报告](https://github.com/Kentucky-ai/opentakeoff/security/advisories/new)提交,
而不是发公开 issue。[SECURITY.md](SECURITY.md) 开门见山地写明了威胁模型 —— 报告之前值得
读一读,它解释了对一个纯客户端应用加一个本地 stdio MCP 服务器来说,信任边界到底在哪里,
以及这决定了什么算漏洞、什么不算。

## 技术栈

- **前端:** React 18 + Vite 6,纯 JSX
- **绘制:** 原生 HTML5 Canvas + SVG —— 不用任何图表或画布框架
- **几何:** TypeScript(`oneclick.ts`、`sheets.ts`),纯函数并有单元测试
- **PDF 渲染:** [pdf.js](https://github.com/mozilla/pdf.js)
- **图纸导入:** fflate(zip)+ pdf-lib(图片 → PDF),懒加载
- **语音:** transformers.js,whisper-tiny.en(q8 编码器 + uint8 解码器)在一个 Web Worker 里 ——
  和其他方案的对比基准见 [`docs/VOICE.md`](docs/VOICE.md)
- **MCP:** 引入网页引擎自身那些库的 TypeScript stdio 服务器
- **存储:** IndexedDB + localStorage —— 不需要后端
- **测试:** `node --test` + `tsx`
- **没有任何付费依赖。**详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 现状

一个用在真实商业标书上的、在用的工具,不是预览版。这套测量引擎就是从一套商用估算系统里剥出来的
生产引擎,同一个引擎无论是回应画布前的人还是回应通过 MCP 接入的智能体,用的都是同一套算法、
同一道比例门槛、同一份来源记录。明确写出来的局限,免得你踩了才发现:**Snap** 是 beta 阶段,
版本比对停留在数量层面而不是几何层面,而翻译版的 README 落后于英文版。欢迎提 issue 和
pull request。

## 谁在做这件事

我在一家商用地面装修公司做估算部门负责人,自己造运行我这个部门的 AI。OpenTakeoff 是这份工作里
开放的那一半:这套测量引擎,交给任何需要读懂一栋建筑图纸的人 —— 不管是人还是智能体。用我们自己的
估算档案训练出来的模型留在我们自己手里,而这条边界被公开划出来,就是为了能被公开问责。

让这份数据有价值的,是它来自真实提交过、真的中标或落标、并对照另外单独归档的报价单核对过的标书。
这也是为什么这个引擎必须免费:一份语料库的质量,取决于有多少真实的算量流经了产出它的这个工具。

—— Michael · [Kentucky AI](https://kentucky-ai.com)

## 许可证

[Apache License 2.0](LICENSE) —— 拿去用、[fork 它](#fork-它)、发布它、在它之上构建。
署名要求见 [NOTICE](NOTICE)。
