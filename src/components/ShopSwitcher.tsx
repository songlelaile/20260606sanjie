"use client";

import { Check, Pencil, Plus, Store, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { ShopSummary } from "@/lib/types/domain";

export function ShopSwitcher({
  shops: initialShops,
  activeShopId: initialActiveShopId,
  limit,
  isAdmin
}: {
  shops: ShopSummary[];
  activeShopId: string;
  limit: number | null;
  canCreate: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [shops, setShops] = useState(initialShops);
  const [activeShopId, setActiveShopId] = useState(initialActiveShopId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const active = useMemo(
    () => shops.find((shop) => shop.id === activeShopId) ?? shops[0],
    [shops, activeShopId]
  );
  const canCreate = isAdmin || limit === null || shops.length < limit;
  const canDelete = shops.length > 1;

  async function switchShop(nextShopId: string) {
    if (!nextShopId || nextShopId === activeShopId) return;
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/shops/active", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopId: nextShopId })
    });
    if (response.ok) {
      setActiveShopId(nextShopId);
      setCreating(false);
      setEditing(false);
      router.refresh();
    } else {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(payload?.error ?? "切换失败");
    }
    setBusy(false);
  }

  function beginEdit() {
    setMessage("");
    setCreating(false);
    setEditName(active?.name ?? "");
    setEditing(true);
  }

  async function saveEdit() {
    if (!active) return;
    const cleanName = editName.trim();
    if (!cleanName) {
      setMessage("请输入店铺名称");
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/shops/${encodeURIComponent(active.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: cleanName })
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { shop: ShopSummary }; error?: string }
      | null;
    if (response.ok && payload?.data?.shop) {
      const shop = payload.data.shop;
      setShops((current) => current.map((item) => (item.id === shop.id ? shop : item)));
      setEditing(false);
      router.refresh();
    } else {
      setMessage(payload?.error ?? "保存失败");
    }
    setBusy(false);
  }

  async function removeActiveShop() {
    if (!active) return;
    if (!canDelete) {
      setMessage("至少保留 1 个店铺");
      return;
    }
    const confirmed = window.confirm(`删除店铺「${active.name}」后，该店铺数据也会删除。确认继续？`);
    if (!confirmed) return;
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/shops/${encodeURIComponent(active.id)}`, {
      method: "DELETE"
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { shops: ShopSummary[]; activeShopId: string }; error?: string }
      | null;
    if (response.ok && payload?.data) {
      setShops(payload.data.shops);
      setActiveShopId(payload.data.activeShopId);
      setEditing(false);
      setCreating(false);
      router.refresh();
    } else {
      setMessage(payload?.error ?? "删除失败");
    }
    setBusy(false);
  }

  async function create() {
    const cleanName = name.trim();
    if (!cleanName) {
      setMessage("请输入店铺名称");
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/shops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: cleanName })
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { shop: ShopSummary }; error?: string }
      | null;
    if (response.ok && payload?.data?.shop) {
      const shop = payload.data.shop;
      setShops((current) => [...current, shop]);
      setName("");
      setCreating(false);
      setEditing(false);
      await switchShop(shop.id);
    } else {
      setMessage(payload?.error ?? "创建失败");
    }
    setBusy(false);
  }

  return (
    <div className="shop-switcher" aria-label="店铺切换">
      <div className="shop-switcher-label">
        <Store size={15} />
        <span>当前店铺</span>
      </div>
      {editing ? (
        <div className="shop-edit-row">
          <input
            value={editName}
            maxLength={40}
            onChange={(event) => setEditName(event.target.value)}
            placeholder="店铺名称"
          />
          <button type="button" className="shop-icon-button" onClick={saveEdit} disabled={busy} title="保存店铺名称">
            <Check size={14} />
          </button>
          <button
            type="button"
            className="shop-icon-button"
            onClick={() => setEditing(false)}
            disabled={busy}
            title="取消编辑"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="shop-select-row">
          <select
            value={active?.id ?? ""}
            disabled={busy || shops.length === 0}
            onChange={(event) => void switchShop(event.target.value)}
            aria-label="选择店铺"
          >
            {shops.map((shop) => (
              <option key={shop.id} value={shop.id}>
                {shop.name}
              </option>
            ))}
          </select>
          <button type="button" className="shop-icon-button" onClick={beginEdit} disabled={busy || !active} title="修改店铺名称">
            <Pencil size={13} />
          </button>
          <button
            type="button"
            className="shop-icon-button danger"
            onClick={() => void removeActiveShop()}
            disabled={busy || !canDelete}
            title={canDelete ? "删除当前店铺" : "至少保留 1 个店铺"}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
      {creating ? (
        <div className="shop-create-row">
          <input
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder="新店铺名称"
          />
          <button type="button" onClick={create} disabled={busy}>
            创建
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="shop-add-button"
          onClick={() => {
            setEditing(false);
            setCreating(true);
          }}
          disabled={busy || !canCreate}
          title={canCreate ? "新增店铺" : "已达到店铺数量上限"}
        >
          <Plus size={14} />
          新增店铺
        </button>
      )}
      {message ? <span className="shop-switcher-message">{message}</span> : null}
    </div>
  );
}
