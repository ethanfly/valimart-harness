/**
 * 把「个人 / 团队」钉到工作区列表最前。
 * 内核 create() 把新建工作区插到 workspaceIds[0]；insertBefore 同步返回、内部排队，
 * 连续调用会各自按调用时的旧顺序计算，后一次覆盖前一次。所以必须等前一次落盘再排下一个。
 */
export async function pinWorkspaceOrder(registry, ids) {
  const wanted = [...new Set(ids.filter(Boolean))]
  if (!wanted.length || typeof registry?.insertBefore !== 'function' || typeof registry?.list !== 'function') return
  for (let i = 0; i < wanted.length; i++) {
    const order = registry.list().map((w) => w.id)
    const present = wanted.filter((id) => order.includes(id))
    const at = present.indexOf(wanted[i])
    if (at < 0 || order[at] === wanted[i]) continue
    const before = at === 0 ? order.find((id) => !present.includes(id)) : order[order.indexOf(present[at - 1]) + 1]
    await registry.insertBefore(wanted[i], before)
  }
}
