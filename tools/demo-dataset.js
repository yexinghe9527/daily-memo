'use strict'

/**
 * 演示数据集（**完全虚构**）。桌面端与手机端的截图共用这一份，
 * 这样 README 里两端的任务标题、数量、类型分布完全一致，不会互相矛盾。
 *
 * day：相对「今天」的天数偏移（0 = 今天，-1 = 昨天，1 = 明天）
 * remindTime：可选，'HH:mm'
 * done：可选，创建后标记为已完成
 *
 * 内容刻意覆盖到这些展示点：工作/私人/未分类三种类型、三档优先级、
 * 到点提醒、每周重复、昨日未完成（触发「顺延自」）、每日备忘、已勾选状态。
 */

module.exports = {
  settings: {
    theme: 'light',
    sortMode: 'manual',
    carryOver: true,
    // 截图进程不该占 8765 端口，也不该联网查更新
    syncEnabled: false,
    autoCheckUpdate: false,
    launchAtLogin: false,
  },

  tasks: [
    // ── 今天 ──
    {
      day: 0,
      title: '把下周的用料清单发给王工',
      note: '含规格号和到货时间，下单前再核一遍数量',
      type: 'work',
      priority: 'urgent',
      remindTime: '14:30',
    },
    { day: 0, title: '核对 3 号机组的装配图', type: 'work', priority: 'important' },
    { day: 0, title: '写本周周报', type: 'work', repeat: 'weekly' },
    { day: 0, title: '整理工具箱', type: 'work', done: true },
    { day: 0, title: '买牛奶和鸡蛋', type: 'personal' },
    { day: 0, title: '给妈妈打电话', note: '聊一下体检结果', type: 'personal' },
    { day: 0, title: '取快递', done: true },

    // ── 昨天：留两条没做完，启动时会顺延到今天并标注「顺延自」 ──
    { day: -1, title: '更新设备台账', type: 'work', priority: 'important' },
    { day: -1, title: '预约牙医', type: 'personal' },
    { day: -1, title: '提交安全自查表', type: 'work', done: true },
    { day: -1, title: '交电费', type: 'personal', done: true },

    // ── 前几天：让日历与统计有内容 ──
    { day: -2, title: '参加班前会', type: 'work', done: true },
    { day: -2, title: '核对备件库存', type: 'work', done: true },
    { day: -2, title: '跑步 5 公里', type: 'personal', done: true },
    { day: -3, title: '整理上周会议纪要', type: 'work', done: true },
    { day: -3, title: '换机油', type: 'personal', done: true },
    { day: -4, title: '打印图纸 A3', type: 'work', done: true },
    { day: -4, title: '读书 30 页', type: 'personal', done: true },
    { day: -5, title: '巡检记录归档', type: 'work', done: true },

    // ── 明天 ──
    { day: 1, title: '把样件送到检测中心', type: 'work', priority: 'important', remindTime: '09:00' },
    { day: 1, title: '家庭聚餐', type: 'personal' },
  ],

  memos: {
    0: '上午先把用料清单发出去，别拖到下午。\n\n李工说 3 号机组的图纸有一处尺寸标注要改，等他回消息。',
    '-1': '安全自查表交了，下周还要复查一次。',
  },
}
