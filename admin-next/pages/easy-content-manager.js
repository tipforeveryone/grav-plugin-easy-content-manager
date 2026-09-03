/**
 * Easy Content Manager — Admin2 plugin page.
 *
 * Reimplements the classic-admin "Content Manager" table: type/language
 * filters + title search against the plugin's own /easy-content-manager/rows
 * endpoint (see classes/EasyContentManagerApiController.php — the query
 * logic itself is unchanged from the admin-classic task handler, only the
 * transport moved from onAdminTaskExecute to a REST route). Deletion goes
 * through the generic DELETE /pages/{route}. Edit links to
 * {basePath}/pages/edit{route} — confirmed by hand in the browser
 * (getgrav/grav-plugin-admin2's Pages editor route).
 */

const TAG = window.__GRAV_PAGE_TAG;
const API_BASE = (window.__GRAV_API_SERVER_URL || '') + (window.__GRAV_API_PREFIX || '/api/v1');
// window.__GRAV_CONFIG__ is set once on the SPA's initial page load (see
// admin2.php's injected config script) and persists across client-side
// navigation, so it's already present by the time this component mounts.
// '/admin2' is this site's configured route (user/config/plugins/admin2.yaml)
// — only used as a fallback if that global is ever missing.
const APP_BASE = window.__GRAV_CONFIG__?.basePath || '/admin2';
// window.__GRAV_API_TOKEN is only a one-time snapshot from when admin2 first
// imports this page component — it's never updated afterwards even though
// the host app keeps rotating the real access token in localStorage on
// every silent refresh, so a page left open across a token rotation would
// send a now-stale token and get a bare 401. currentAccessToken() re-reads
// the live token from the same localStorage key the host app itself writes
// to (see ftp-sync's admin-next/pages/ftp-sync.js for the fuller writeup —
// this plugin hit the same bug).
const API_TOKEN_FALLBACK = window.__GRAV_API_TOKEN;

function currentAccessToken() {
    try {
        const keys = ['grav_admin_auth::/admin2', 'grav_admin_auth'];
        for (const key of keys) {
            const raw = localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken) {
                    return parsed.accessToken;
                }
            }
        }
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.indexOf('grav_admin_auth') === 0) {
                const raw = localStorage.getItem(key);
                const parsed = raw ? JSON.parse(raw) : null;
                if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken) {
                    return parsed.accessToken;
                }
            }
        }
    } catch (e) {
        // localStorage unavailable -> fall back to the load-time snapshot.
    }
    return API_TOKEN_FALLBACK;
}

class EasyContentManagerPage extends HTMLElement {
    constructor() {
        super();
        this._rows = [];
        this._typeOptions = {};
        this._languageOptions = {};
        this._slmsActive = false;
        this._filters = { type: '', language: '', q: '' };
        this._searchDebounce = null;
    }

    connectedCallback() {
        this.dispatchEvent(new CustomEvent('page-state', {
            detail: { title: 'Content Manager', icon: 'fa-list' },
        }));
        this._renderShell();
        this._load();
    }

    async _fetch(path, options = {}) {
        const token = currentAccessToken();
        const res = await fetch(API_BASE + path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(options.headers || {}),
            },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(body?.error?.message || body?.message || `Request failed (${res.status})`);
        }
        return body;
    }

    async _load() {
        const params = new URLSearchParams();
        if (this._filters.type) params.set('type', this._filters.type);
        if (this._filters.language) params.set('language', this._filters.language);
        if (this._filters.q) params.set('q', this._filters.q);

        const tbody = this.querySelector('.ecm-tbody');
        if (tbody) tbody.innerHTML = `<tr><td class="ecm-td-empty" colspan="6">Đang tải…</td></tr>`;

        try {
            const res = await this._fetch(`/easy-content-manager/rows?${params.toString()}`);
            const data = res.data ?? {};
            this._rows = Array.isArray(data.rows) ? data.rows : [];
            this._typeOptions = data.type_options ?? {};
            this._languageOptions = data.language_options ?? {};
            this._slmsActive = !!data.slms_active;
            this._renderShell();
            this._renderRows();
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td class="ecm-td-empty ecm-error" colspan="6">${this._escape(err.message || 'Load failed')}</td></tr>`;
            }
        }
    }

    async _deleteRow(row, trEl) {
        if (!window.confirm(`Xoá "${row.title}"? Không thể hoàn tác.`)) {
            return;
        }
        trEl.style.opacity = '0.5';
        try {
            await this._fetch(`/pages${row.route}`, { method: 'DELETE' });
            this._rows = this._rows.filter((r) => r.route !== row.route);
            trEl.remove();
        } catch (err) {
            trEl.style.opacity = '1';
            window.alert(err.message || 'Xoá thất bại');
        }
    }

    _copyRoute(route, btnEl) {
        navigator.clipboard?.writeText(route).then(() => {
            const original = btnEl.textContent;
            btnEl.textContent = 'Đã chép';
            setTimeout(() => { btnEl.textContent = original; }, 1200);
        });
    }

    _renderShell() {
        const typeOpts = Object.entries(this._typeOptions)
            .map(([slug, label]) => `<option value="${this._escape(slug)}" ${this._filters.type === slug ? 'selected' : ''}>${this._escape(label)}</option>`)
            .join('');
        const langOpts = Object.entries(this._languageOptions)
            .map(([code, label]) => `<option value="${this._escape(code)}" ${this._filters.language === code ? 'selected' : ''}>${this._escape(label)}</option>`)
            .join('');

        this.innerHTML = `
            ${this._styles()}
            <div class="ecm-wrapper">
                <div class="ecm-toolbar">
                    <select class="ecm-select" data-role="type">
                        <option value="">Tất cả content type</option>
                        ${typeOpts}
                    </select>
                    ${this._slmsActive ? `
                        <select class="ecm-select" data-role="language">
                            <option value="">Tất cả ngôn ngữ</option>
                            ${langOpts}
                        </select>
                    ` : ''}
                    <input type="search" class="ecm-search" data-role="search" placeholder="Tìm theo tiêu đề…" value="${this._escape(this._filters.q)}" />
                </div>
                <table class="ecm-table">
                    <thead>
                        <tr>
                            <th>Tiêu đề</th>
                            <th>Loại</th>
                            ${this._slmsActive ? '<th>Ngôn ngữ</th><th>Bản dịch</th>' : ''}
                            <th>Ngày</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody class="ecm-tbody"></tbody>
                </table>
            </div>
        `;

        const typeSelect = this.querySelector('[data-role="type"]');
        typeSelect?.addEventListener('change', (e) => {
            this._filters.type = e.target.value;
            this._load();
        });
        const langSelect = this.querySelector('[data-role="language"]');
        langSelect?.addEventListener('change', (e) => {
            this._filters.language = e.target.value;
            this._load();
        });
        const searchInput = this.querySelector('[data-role="search"]');
        searchInput?.addEventListener('input', (e) => {
            const value = e.target.value;
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => {
                this._filters.q = value;
                this._load();
            }, 300);
        });
    }

    _renderRows() {
        const tbody = this.querySelector('.ecm-tbody');
        if (!tbody) return;

        if (this._rows.length === 0) {
            tbody.innerHTML = `<tr><td class="ecm-td-empty" colspan="6">Không có nội dung khớp.</td></tr>`;
            return;
        }

        tbody.innerHTML = this._rows.map((row, i) => `
            <tr data-index="${i}">
                <td class="ecm-title">
                    ${this._escape(row.title)}
                    <div class="ecm-route">
                        <code>${this._escape(row.route)}</code>
                        <button type="button" class="ecm-copy-btn" data-action="copy">Chép</button>
                    </div>
                </td>
                <td>${this._escape(row.type_label)}</td>
                ${this._slmsActive ? `
                    <td>${this._escape(row.language_label || '—')}</td>
                    <td class="${row.translation === 'OK' ? 'ecm-ok' : 'ecm-missing'}">${this._escape(row.translation || '—')}</td>
                ` : ''}
                <td>${this._escape(row.date)}</td>
                <td class="ecm-actions">
                    <a class="ecm-edit-btn" href="${this._escape(APP_BASE)}/pages/edit${this._escape(row.route)}">Sửa</a>
                    <button type="button" class="ecm-delete-btn" data-action="delete">Xoá</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('tr').forEach((trEl) => {
            const row = this._rows[Number(trEl.dataset.index)];
            trEl.querySelector('[data-action="delete"]')?.addEventListener('click', () => this._deleteRow(row, trEl));
            trEl.querySelector('[data-action="copy"]')?.addEventListener('click', (e) => this._copyRoute(row.route, e.target));
        });
    }

    _escape(str) {
        const div = document.createElement('div');
        div.textContent = String(str ?? '');
        return div.innerHTML;
    }

    _styles() {
        return `
            <style>
                .ecm-wrapper { display: flex; flex-direction: column; gap: 12px; font-family: inherit; padding: 4px; }
                .ecm-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
                .ecm-select, .ecm-search { border: 1px solid var(--border, #e5e7eb); border-radius: 6px; padding: 6px 10px; font-size: 13px; background: var(--card, #fff); color: var(--foreground, #1f2937); }
                .ecm-search { flex: 1; min-width: 180px; }
                .ecm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
                .ecm-table th { text-align: left; padding: 8px 10px; color: var(--muted-foreground, #6b7280); font-weight: 600; border-bottom: 1px solid var(--border, #e5e7eb); }
                .ecm-table td { padding: 8px 10px; border-bottom: 1px solid var(--border, #e5e7eb); vertical-align: top; color: var(--foreground, #1f2937); }
                .ecm-td-empty { text-align: center; color: var(--muted-foreground, #6b7280); padding: 24px 10px; }
                .ecm-error { color: var(--destructive, #dc2626); }
                .ecm-route { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
                .ecm-route code { font-size: 11px; color: var(--muted-foreground, #6b7280); }
                .ecm-copy-btn, .ecm-edit-btn, .ecm-delete-btn { display: inline-block; border: 1px solid var(--border, #e5e7eb); background: var(--card, #fff); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; color: var(--foreground, #1f2937); text-decoration: none; }
                .ecm-edit-btn { color: var(--primary, #3b82f6); border-color: var(--primary, #3b82f6); margin-right: 4px; }
                .ecm-delete-btn { color: var(--destructive, #dc2626); border-color: var(--destructive, #dc2626); }
                .ecm-copy-btn:hover, .ecm-edit-btn:hover, .ecm-delete-btn:hover { opacity: 0.8; }
                .ecm-ok { color: var(--success, #16a34a); }
                .ecm-missing { color: var(--destructive, #dc2626); }
                .ecm-actions { text-align: right; }
            </style>
        `;
    }
}

customElements.define(TAG, EasyContentManagerPage);
