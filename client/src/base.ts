/**
 * 页面挂载目录。
 *
 * 产物用相对路径，可能被宿主挂在 `/dead-kill/`，也可能直接访问 `/dead-kill`
 * （无尾斜杠）。后者如果按“去掉最后一段”算会得到空串，API/WS 就打到根路径。
 * 这里把“没有扩展名的路径”当成目录，补上尾斜杠。
 */
export function pageBase(pathname: string): string {
  if (!pathname.startsWith('/')) return '/'
  if (pathname.endsWith('/')) return pathname
  return pathname.includes('.') ? pathname.replace(/[^/]*$/, '') : `${pathname}/`
}
