'use strict';

// macOS 应用菜单：遵循系统菜单习惯（应用 / 文件 / 编辑 / 播放 / 视图 / 窗口 / 帮助）
module.exports.buildMenu = function buildMenu(ctx) {
  const { appName, sendCommand, toggleMini, showMain, openExternal, getMiniOpen } = ctx;

  const template = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        {
          label: '偏好设置…',
          accelerator: 'Cmd+,',
          click: () => sendCommand('open-preferences'),
        },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}` },
      ],
    },
    {
      label: '播放',
      submenu: [
        { label: '播放 / 暂停', click: () => sendCommand('toggle') },
        { label: '上一首', accelerator: 'Cmd+Left', click: () => sendCommand('prev') },
        { label: '下一首', accelerator: 'Cmd+Right', click: () => sendCommand('next') },
        { type: 'separator' },
        { label: '喜欢这首歌', accelerator: 'Cmd+L', click: () => sendCommand('like') },
        { type: 'separator' },
        { label: '音量 +', accelerator: 'Cmd+Up', click: () => sendCommand('volume-up') },
        { label: '音量 −', accelerator: 'Cmd+Down', click: () => sendCommand('volume-down') },
        { label: '静音 / 取消静音', accelerator: 'Cmd+Alt+M', click: () => sendCommand('mute') },
        { type: 'separator' },
        { label: '播放队列', accelerator: 'Cmd+U', click: () => sendCommand('queue') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '首页', accelerator: 'Cmd+1', click: () => sendCommand('nav-home') },
        { label: '搜索', accelerator: 'Cmd+F', click: () => sendCommand('focus-search') },
        { label: '我的曲库', accelerator: 'Cmd+2', click: () => sendCommand('nav-mine') },
        { type: 'separator' },
        {
          label: '迷你播放器',
          accelerator: 'Cmd+Shift+M',
          type: 'checkbox',
          checked: getMiniOpen ? getMiniOpen() : false,
          click: toggleMini,
        },
        { label: '主窗口', accelerator: 'Cmd+Shift+O', click: showMain },
        { type: 'separator' },
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: 'GitHub 仓库', click: () => openExternal('https://github.com/jibai33/earworm_mac') },
        { label: '问题反馈', click: () => openExternal('https://github.com/jibai33/earworm_mac/issues') },
        { type: 'separator' },
        { label: '开源许可（GPL-3.0）', click: () => openExternal('https://www.gnu.org/licenses/gpl-3.0.html') },
      ],
    },
  ];

  return require('electron').Menu.buildFromTemplate(template);
};
