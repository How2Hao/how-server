// 银行卡视觉识别 Prompt 常量（逐字对应旧 how-api src/service/bank_card_vision_prompts.ts）
import type { BankCardVisionProvider } from './bank-card-vision-providers.ts'

/**
 * 三家模型共用的输出约定（字段名须与 parseRecognitionArray 一致）
 */
const SHARED_JSON_OUTPUT = `
# 输出格式（键名必须与服务端解析一致，一字不差）
仅返回纯 JSON 对象，不要 Markdown 代码块、不要前后说明文字：
{
  "cards": [
    {
      "bankName": "银行名称",
      "cardLastFour": "后四位",
      "cardType": "类型，无则 null",
      "coverImgPosition": [x_min, y_min, x_max, y_max]
    }
  ]
}
- coverImgPosition：相对**原图宽高**的 **0–1000** 归一化刻度；格式 [x_min, y_min, x_max, y_max]；只框选**左侧银行卡封面小图**（含 Logo/卡面），勿含右侧文字与按钮。
`

/** 通义千问（DashScope）多模态：长列表锚点 + 均匀分布策略 */
export const BANK_CARD_RECOGNITION_PROMPT_QWEN = `
# Role
  你是一个高精度的金融卡片信息提取助手。你的核心任务是从长截图中识别银行卡，并输出**像素级精准**的坐标。

  # Critical Goal (最高优先级)
  **确保列表顶部的第 1 张和第 2 张卡片的坐标绝对准确！**
  后续所有卡片的定位将严格依赖这两张卡的间距进行推算。如果前两张卡有偏差，整个结果将失效。

  # Extraction Rules
  对每张卡提取以下字段：
  - bankName: 银行名称。
  - cardLastFour: 卡号后四位。
  - cardType: 卡片类型。
  - coverImgPosition: [x_min, y_min, x_max, y_max] (0-1000 归一化坐标)。

  # ⚠️ 坐标标注铁律 (必须严格遵守)
  1. **锚点优先 (Anchor Priority)**：
     - **第 1 张和第 2 张卡片**：请投入最大注意力。必须反复检查其上下边缘。
     - **顶部对齐 (Top Alignment)**：$y_{min}$ (框的顶部) 必须**严格贴合**卡片封面的最上边缘（包含银行 Logo、顶部边框）。**严禁**截断卡片顶部，哪怕 1 个像素也不行。
     - **底部对齐 (Bottom Alignment)**：$y_{max}$ (框的底部) 必须严格贴合卡片封面的最下边缘。

  2. **高度一致性 (Height Consistency)**：
     - 列表中所有卡片的封面图物理尺寸相同。
     - **强制约束**：第 1 张卡的高度 ($h_1$) 必须等于第 2 张卡的高度 ($h_2$)。
     - 如果发现 $h_1 \\neq h_2$，请重新校准，确保两者高度完全一致。这将是计算后续卡片位置的基准步长。

  3. **垂直间距 (Vertical Spacing)**：
     - 银行卡列表通常是等距排列的。
     - 请精确测量第 1 张卡中心点到第 2 张卡中心点的垂直距离，这个距离将作为标准步长。

  4. **抗长图漂移 (Anti-Drift)**：
     - 对于第 3 张及以后的卡片，虽然由程序自动推算位置，但你在标注时仍需保持垂直方向的线性感，不要出现忽大忽小的抖动。
     - **X 轴精准**：左右边界 ($x_{min}, x_{max}$) 必须紧密贴合封面图边缘，不要包含右侧的文字信息。

  5. **坐标系统**：
     - 基于原图宽高的归一化坐标 (0-1000)。
     - 格式：[x_min, y_min, x_max, y_max]。
     - 顺序：与截图从上到下一致。

  # Output Format
  仅返回标准 JSON，无 Markdown 标记，无解释文字。
  {
    "cards": [
      {
        "bankName": "...",
        "cardLastFour": "...",
        "cardType": "...",
        "coverImgPosition": [x1, y1, x2, y2]
      },
      ...
    ]
  }

  # Self-Correction Checklist (Before Output)
  - [ ] 第 1 张卡的顶部是否包含了完整的 Logo？
  - [ ] 第 1 张卡和第 2 张卡的高度是否完全一致？
  - [ ] 第 2 张卡的位置是否严格遵循了与第 1 张卡的固定间距？
  - [ ] 是否有任何卡片的顶部被截断？(如有，立即修正 y_min)

  # Task
  请分析图片，重点校准前两张卡片，提取所有信息并返回 JSON。
`.trim()

/** 智谱 GLM 视觉：强调中文场景与稳定 JSON */
export const BANK_CARD_RECOGNITION_PROMPT_GLM = `
# Role（智谱 GLM 视觉）
你处理手机银行「我的银行卡」类**中文界面长截图**，需识别每条列表左侧的**银行卡封面缩略图**区域。

# 任务
- 从上到下识别**全部**银行卡条目。
- 每张卡提取：银行名、卡号后四位、卡片类型（无则 null）、封面区域框。
- 框选须紧贴**左侧封面图**（Logo+卡面），**不要**把右侧银行名称、操作按钮算进框内。

# 坐标
- 使用相对原图宽、高的 **0–1000** 刻度：x 按宽度、y 按高度线性映射。
- coverImgPosition 为 [x_min, y_min, x_max, y_max]，整数或小数均可。

# 输出纪律
- **只输出 JSON**，不要 \`\`\`json 代码围栏、不要解释。
${SHARED_JSON_OUTPUT}
# Task
直接输出满足格式的 JSON 对象。
`.trim()

/** Google Gemini：英文角色说明 + 中文键名 JSON（与解析器一致） */
export const BANK_CARD_RECOGNITION_PROMPT_GEMINI = `
# Role
  你是一个高精度的金融卡片信息提取助手。你的核心任务是从长截图中识别银行卡，并输出**像素级精准**的坐标。

  # Critical Goal (最高优先级)
  **确保列表顶部的第 1 张和第 2 张卡片的坐标绝对准确！**
  后续所有卡片的定位将严格依赖这两张卡的间距进行推算。如果前两张卡有偏差，整个结果将失效。

  # Extraction Rules
  对每张卡提取以下字段：
  - bankName: 银行名称。
  - cardLastFour: 卡号后四位。
  - cardType: 卡片类型。
  - coverImgPosition: [x_min, y_min, x_max, y_max] (0-1000 归一化坐标)。

  # ⚠️ 坐标标注铁律 (必须严格遵守)
  1. **锚点优先 (Anchor Priority)**：
     - **第 1 张和第 2 张卡片**：请投入最大注意力。必须反复检查其上下边缘。
     - **顶部对齐 (Top Alignment)**：$y_{min}$ (框的顶部) 必须**严格贴合**卡片封面的最上边缘（包含银行 Logo、顶部边框）。**严禁**截断卡片顶部，哪怕 1 个像素也不行。
     - **底部对齐 (Bottom Alignment)**：$y_{max}$ (框的底部) 必须严格贴合卡片封面的最下边缘。

  2. **高度一致性 (Height Consistency)**：
     - 列表中所有卡片的封面图物理尺寸相同。
     - **强制约束**：第 1 张卡的高度 ($h_1$) 必须等于第 2 张卡的高度 ($h_2$)。
     - 如果发现 $h_1 \\neq h_2$，请重新校准，确保两者高度完全一致。这将是计算后续卡片位置的基准步长。

  3. **垂直间距 (Vertical Spacing)**：
     - 银行卡列表通常是等距排列的。
     - 请精确测量第 1 张卡中心点到第 2 张卡中心点的垂直距离，这个距离将作为标准步长。

  4. **抗长图漂移 (Anti-Drift)**：
     - 对于第 3 张及以后的卡片，虽然由程序自动推算位置，但你在标注时仍需保持垂直方向的线性感，不要出现忽大忽小的抖动。
     - **X 轴精准**：左右边界 ($x_{min}, x_{max}$) 必须紧密贴合封面图边缘，不要包含右侧的文字信息。

  5. **坐标系统**：
     - 基于原图宽高的归一化坐标 (0-1000)。
     - 格式：[x_min, y_min, x_max, y_max]。
     - 顺序：与截图从上到下一致。

  # Output Format
  仅返回标准 JSON，无 Markdown 标记，无解释文字。
  {
    "cards": [
      {
        "bankName": "...",
        "cardLastFour": "...",
        "cardType": "...",
        "coverImgPosition": [x1, y1, x2, y2]
      },
      ...
    ]
  }

  # Self-Correction Checklist (Before Output)
  - [ ] 第 1 张卡的顶部是否包含了完整的 Logo？
  - [ ] 第 1 张卡和第 2 张卡的高度是否完全一致？
  - [ ] 第 2 张卡的位置是否严格遵循了与第 1 张卡的固定间距？
  - [ ] 是否有任何卡片的顶部被截断？(如有，立即修正 y_min)

  # Task
  请分析图片，重点校准前两张卡片，提取所有信息并返回 JSON。
`.trim()

export function getBankCardRecognitionPrompt(provider: BankCardVisionProvider): string {
  switch (provider) {
    case 'glm':
      return BANK_CARD_RECOGNITION_PROMPT_GLM
    case 'gemini':
      return BANK_CARD_RECOGNITION_PROMPT_GEMINI
    default:
      return BANK_CARD_RECOGNITION_PROMPT_QWEN
  }
}
