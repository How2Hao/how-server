// 新用户默认资料（与旧系统一致）
const BASE = 'https://how2hao-static.oss-cn-beijing.aliyuncs.com/default'

export const Defaults = {
  user: {
    username: '羊羊羊',
    avatar: `${BASE}/default_user_avatar.png`,
  },
  ledger: {
    name: '默认账本',
    // acc_ledgers.icon 为 varchar(20)（emoji/icon key），旧代码写入 URL 在严格模式下会超长，
    // 真实库数据均为 emoji，此处与数据现状对齐
    icon: '📒',
  },
  accUser: {
    username: '财务总监',
    avatar: `${BASE}/default_acc_user_avatar.png`,
  },
} as const
