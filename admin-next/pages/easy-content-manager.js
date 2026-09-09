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

// Distinct from admin-classic's 'ecm-filters' localStorage key (different
// shape, and localStorage is shared per-origin regardless of admin route).
const FILTERS_STORAGE_KEY = 'ecm-admin2-filters';

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
        this._filters = { type: '', language: '', q: '', privateOnly: false };
        this._searchDebounce = null;
        this._selected = new Set();
        this._sort = { field: 'date_ts', dir: 'desc' };
        this._ftpSyncAvailable = false;
        this._ftpSyncRoute = null;
        this._ftpSyncRows = null;
        this._restoreFilters();
    }

    // Nhớ filter + sort qua các lần rời/quay lại trang Content Manager trong
    // admin2 (mỗi lần điều hướng, component này bị huỷ và tạo lại từ đầu nên
    // không thể giữ state trong bộ nhớ như admin-classic — phải dùng
    // localStorage), giống hành vi saveFilters/restoreFilters bên admin-classic.
    _restoreFilters() {
        try {
            const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (saved.type !== undefined) this._filters.type = saved.type;
            if (saved.language !== undefined) this._filters.language = saved.language;
            if (saved.q !== undefined) this._filters.q = saved.q;
            if (saved.privateOnly !== undefined) this._filters.privateOnly = saved.privateOnly;
            if (saved.sortField !== undefined) this._sort.field = saved.sortField;
            if (saved.sortDir !== undefined) this._sort.dir = saved.sortDir;
        } catch (e) {
            // private browsing / storage blocked / bad JSON — ignore
        }
    }

    _saveFilters() {
        try {
            localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
                type: this._filters.type,
                language: this._filters.language,
                q: this._filters.q,
                privateOnly: this._filters.privateOnly,
                sortField: this._sort.field,
                sortDir: this._sort.dir,
            }));
        } catch (e) {
            // private browsing / storage blocked — ignore
        }
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
            throw new Error(body?.detail || body?.error?.message || body?.message || `Request failed (${res.status})`);
        }
        return body;
    }

    _buildQueryParams() {
        const params = new URLSearchParams();
        if (this._filters.type) params.set('type', this._filters.type);
        if (this._filters.language) params.set('language', this._filters.language);
        if (this._filters.q) params.set('q', this._filters.q);
        if (this._filters.privateOnly) params.set('private_only', '1');
        return params;
    }

    async _load() {
        const params = this._buildQueryParams();

        const tbody = this.querySelector('.ecm-tbody');
        if (tbody) tbody.innerHTML = `<tr><td class="ecm-td-empty" colspan="${this._colCount()}">Đang tải…</td></tr>`;

        try {
            const res = await this._fetch(`/easy-content-manager/rows?${params.toString()}`);
            const data = res.data ?? {};
            this._rows = Array.isArray(data.rows) ? data.rows : [];
            this._typeOptions = data.type_options ?? {};
            this._languageOptions = data.language_options ?? {};
            this._slmsActive = !!data.slms_active;
            this._ftpSyncAvailable = !!data.ftp_sync_available;
            this._selected = new Set();
            this._applySort();
            this._renderShell();
            this._renderRows();
        } catch (err) {
            if (tbody) {
                tbody.innerHTML = `<tr><td class="ecm-td-empty ecm-error" colspan="${this._colCount()}">${this._escape(err.message || 'Load failed')}</td></tr>`;
            }
        }
    }

    /**
     * Re-fetch rows and re-render ONLY the tbody (not _renderShell(), which
     * replaces this.innerHTML wholesale — that would tear down the FTP Sync
     * modal DOM while it's still open showing the just-applied result).
     * Used after _applyFtpSync() to refresh stale row dates without closing
     * the modal.
     */
    async _refreshRowsSilently() {
        try {
            const res = await this._fetch(`/easy-content-manager/rows?${this._buildQueryParams().toString()}`);
            const data = res.data ?? {};
            this._rows = Array.isArray(data.rows) ? data.rows : [];
            this._applySort();
            this._renderRows();
        } catch (err) {
            // Best-effort — table just stays stale until the next explicit filter/reload.
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
            this._selected.delete(row.route);
            trEl.remove();
        } catch (err) {
            trEl.style.opacity = '1';
            window.alert(err.message || 'Xoá thất bại');
        }
    }

    _ftpSyncDefaultResolution(row) {
        if (row.type === 'changed') {
            if (row.newer === 'local') return 'local';
            if (row.newer === 'remote') return 'remote';
            return '';
        }
        if (row.type === 'missing_remote') return 'local';
        if (row.type === 'missing_local') return 'remote';
        return '';
    }

    _ftpSyncStatusLabel(row) {
        if (row.type === 'changed') {
            if (row.newer === 'local') return 'Khác nhau — Local mới hơn';
            if (row.newer === 'remote') return 'Khác nhau — Hosting mới hơn';
            return 'Khác nhau — không rõ bên nào mới hơn';
        }
        if (row.type === 'missing_remote') return 'Chỉ có ở Local (chưa có trên Hosting)';
        if (row.type === 'missing_local') return 'Chỉ có ở Hosting (chưa có ở Local)';
        return row.type;
    }

    _ftpSyncStatusClass(row) {
        if (row.type === 'missing_remote') return 'ecm-ftpsync-local-only';
        if (row.type === 'missing_local') return 'ecm-ftpsync-host-only';
        if (row.type === 'changed' && row.newer) return 'ecm-ftpsync-newer';
        return 'ecm-ftpsync-unknown';
    }

    _ftpSyncFormatStat(stat) {
        if (!stat) return '—';
        const d = new Date(stat.mtime * 1000);
        return `${stat.size} bytes, ${d.toLocaleString()}`;
    }

    _closeFtpSyncModal() {
        const overlay = this.querySelector('[data-role="ftpsync-overlay"]');
        overlay?.classList.remove('ecm-open');
        this._ftpSyncRoute = null;
        this._ftpSyncRows = null;
    }

    async _openFtpSyncModal(route, title) {
        this._ftpSyncRoute = route;
        this._ftpSyncRows = null;

        const overlay = this.querySelector('[data-role="ftpsync-overlay"]');
        const titleEl = this.querySelector('[data-role="ftpsync-title"]');
        const bodyEl = this.querySelector('[data-role="ftpsync-body"]');
        const statusEl = this.querySelector('[data-role="ftpsync-status"]');
        const applyBtn = this.querySelector('[data-role="ftpsync-apply"]');

        if (titleEl) titleEl.textContent = title;
        if (statusEl) statusEl.textContent = '';
        if (bodyEl) bodyEl.innerHTML = `<div class="ecm-ftpsync-empty">Đang kiểm tra…</div>`;
        if (applyBtn) applyBtn.disabled = true;
        overlay?.classList.add('ecm-open');

        try {
            const res = await this._fetch('/easy-content-manager/ftp-sync/check', {
                method: 'POST',
                body: JSON.stringify({ route }),
            });
            if (this._ftpSyncRoute !== route) return;
            this._ftpSyncRows = (res.data ?? {}).rows ?? {};
            this._renderFtpSyncRows();
        } catch (err) {
            if (this._ftpSyncRoute !== route) return;
            if (bodyEl) bodyEl.innerHTML = `<div class="ecm-ftpsync-empty ecm-error">${this._escape(err.message || 'Check failed')}</div>`;
        }
    }

    _renderFtpSyncRows() {
        const bodyEl = this.querySelector('[data-role="ftpsync-body"]');
        const applyBtn = this.querySelector('[data-role="ftpsync-apply"]');
        if (!bodyEl) return;

        const paths = Object.keys(this._ftpSyncRows || {});
        if (paths.length === 0) {
            bodyEl.innerHTML = `<div class="ecm-ftpsync-empty">Không có khác biệt nào — Local và Hosting đã khớp.</div>`;
            if (applyBtn) applyBtn.disabled = true;
            return;
        }

        if (applyBtn) applyBtn.disabled = false;

        const options = [
            ['', '-- Bỏ qua --'],
            ['local', 'Đẩy lên Hosting (Local → Remote)'],
            ['remote', 'Kéo về Local (Remote → Local)'],
            ['delete_local', 'Xoá ở Local'],
            ['delete_remote', 'Xoá ở Hosting'],
        ];

        const rowsHtml = paths.map((path) => {
            const row = this._ftpSyncRows[path];
            const def = this._ftpSyncDefaultResolution(row);
            const optionsHtml = options.map(([value, label]) => `<option value="${value}" ${value === def ? 'selected' : ''}>${label}</option>`).join('');
            return `
                <tr>
                    <td class="ecm-ftpsync-path">${this._escape(path)}</td>
                    <td class="${this._ftpSyncStatusClass(row)}">${this._escape(this._ftpSyncStatusLabel(row))}</td>
                    <td>${this._escape(this._ftpSyncFormatStat(row.local))}</td>
                    <td>${this._escape(this._ftpSyncFormatStat(row.remote))}</td>
                    <td><select class="ecm-ftpsync-resolution" data-path="${this._escape(path)}">${optionsHtml}</select></td>
                </tr>
            `;
        }).join('');

        bodyEl.innerHTML = `
            <table class="ecm-ftpsync-table">
                <thead><tr><th>File</th><th>Trạng thái</th><th>Local</th><th>Hosting</th><th>Xử lý</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        `;
    }

    async _applyFtpSync() {
        if (!this._ftpSyncRoute) return;

        const bodyEl = this.querySelector('[data-role="ftpsync-body"]');
        const statusEl = this.querySelector('[data-role="ftpsync-status"]');
        const applyBtn = this.querySelector('[data-role="ftpsync-apply"]');

        const resolutions = {};
        bodyEl?.querySelectorAll('.ecm-ftpsync-resolution').forEach((select) => {
            if (select.value) resolutions[select.dataset.path] = select.value;
        });

        if (Object.keys(resolutions).length === 0) {
            window.alert('Chưa chọn cách xử lý cho file nào.');
            return;
        }

        if (applyBtn) applyBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Đang áp dụng…';

        const route = this._ftpSyncRoute;

        try {
            const res = await this._fetch('/easy-content-manager/ftp-sync/apply', {
                method: 'POST',
                body: JSON.stringify({ route, resolutions }),
            });
            const data = res.data ?? {};
            let msg = `Đã áp dụng ${data.applied ?? 0} file.`;
            if (data.skipped) msg += ` Bỏ qua/lỗi: ${data.skipped}.`;
            if (data.backup) msg += ` Backup: ${data.backup}.`;
            if (statusEl) statusEl.textContent = msg;

            await this._openFtpSyncModal(route, this.querySelector('[data-role="ftpsync-title"]')?.textContent || '');
            this._refreshRowsSilently();
        } catch (err) {
            if (statusEl) statusEl.textContent = err.message || 'Apply failed';
            if (applyBtn) applyBtn.disabled = false;
        }
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
                    <label class="ecm-checkbox-label">
                        <input type="checkbox" data-role="private-only" ${this._filters.privateOnly ? 'checked' : ''} /> Private only
                    </label>
                </div>
                <div class="ecm-bulk-bar">
                    <button type="button" class="ecm-btn" data-role="select-translations">Chọn các bản dịch</button>
                    <select class="ecm-select" data-role="bulk-action">
                        <option value="">-- Chọn hành động --</option>
                        <option value="delete">Xoá</option>
                        <option value="private">Đánh dấu Private</option>
                    </select>
                    <button type="button" class="ecm-btn ecm-btn-primary" data-role="apply-bulk">Áp dụng</button>
                    <span class="ecm-selected-count" data-role="selected-count"></span>
                </div>
                <table class="ecm-table">
                    <thead>
                        <tr>
                            <th class="ecm-th-check"><input type="checkbox" data-role="select-all" /></th>
                            <th>Tiêu đề</th>
                            <th>Loại</th>
                            ${this._slmsActive ? '<th>Ngôn ngữ</th><th>Bản dịch</th>' : ''}
                            ${this._sortableHeader('Ngày đăng', 'date_ts')}
                            ${this._sortableHeader('Ngày sửa', 'modified_ts')}
                            ${this._ftpSyncAvailable ? '<th>FTP Sync</th>' : ''}
                            <th></th>
                        </tr>
                    </thead>
                    <tbody class="ecm-tbody"></tbody>
                </table>
            </div>
            ${this._ftpSyncAvailable ? `
            <div class="ecm-ftpsync-overlay" data-role="ftpsync-overlay">
                <div class="ecm-ftpsync-modal">
                    <div class="ecm-ftpsync-modal-header">
                        <h3>FTP Sync — <span data-role="ftpsync-title"></span></h3>
                        <button type="button" class="ecm-ftpsync-close" data-role="ftpsync-close">&times;</button>
                    </div>
                    <div class="ecm-ftpsync-modal-body" data-role="ftpsync-body"></div>
                    <div class="ecm-ftpsync-modal-footer">
                        <span class="ecm-ftpsync-status" data-role="ftpsync-status"></span>
                        <button type="button" class="ecm-btn" data-role="ftpsync-cancel">Đóng</button>
                        <button type="button" class="ecm-btn ecm-btn-primary" data-role="ftpsync-apply">Áp dụng</button>
                    </div>
                </div>
            </div>
            ` : ''}
        `;

        const typeSelect = this.querySelector('[data-role="type"]');
        typeSelect?.addEventListener('change', (e) => {
            this._filters.type = e.target.value;
            this._saveFilters();
            this._load();
        });
        const langSelect = this.querySelector('[data-role="language"]');
        langSelect?.addEventListener('change', (e) => {
            this._filters.language = e.target.value;
            this._saveFilters();
            this._load();
        });
        const searchInput = this.querySelector('[data-role="search"]');
        searchInput?.addEventListener('input', (e) => {
            const value = e.target.value;
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => {
                this._filters.q = value;
                this._saveFilters();
                this._load();
            }, 300);
        });
        const privateOnlyCheckbox = this.querySelector('[data-role="private-only"]');
        privateOnlyCheckbox?.addEventListener('change', (e) => {
            this._filters.privateOnly = e.target.checked;
            this._saveFilters();
            this._load();
        });

        const selectAllCheckbox = this.querySelector('[data-role="select-all"]');
        selectAllCheckbox?.addEventListener('change', () => {
            if (selectAllCheckbox.checked) {
                this._rows.forEach((r) => this._selected.add(r.route));
            } else {
                this._selected.clear();
            }
            this._renderRows();
        });

        const selectTranslationsBtn = this.querySelector('[data-role="select-translations"]');
        selectTranslationsBtn?.addEventListener('click', () => this._selectTranslations());

        const applyBtn = this.querySelector('[data-role="apply-bulk"]');
        applyBtn?.addEventListener('click', () => this._applyBulkAction());

        this.querySelectorAll('[data-sort-field]').forEach((th) => {
            th.addEventListener('click', () => {
                const field = th.dataset.sortField;
                if (this._sort.field === field) {
                    this._sort.dir = this._sort.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    this._sort.field = field;
                    this._sort.dir = 'desc';
                }
                this._saveFilters();
                this._applySort();
                this._renderShell();
                this._renderRows();
            });
        });

        if (this._ftpSyncAvailable) {
            const closeBtn = this.querySelector('[data-role="ftpsync-close"]');
            const cancelBtn = this.querySelector('[data-role="ftpsync-cancel"]');
            const overlay = this.querySelector('[data-role="ftpsync-overlay"]');
            const applyBtn = this.querySelector('[data-role="ftpsync-apply"]');
            closeBtn?.addEventListener('click', () => this._closeFtpSyncModal());
            cancelBtn?.addEventListener('click', () => this._closeFtpSyncModal());
            overlay?.addEventListener('click', (e) => { if (e.target === overlay) this._closeFtpSyncModal(); });
            applyBtn?.addEventListener('click', () => this._applyFtpSync());
        }
    }

    _colCount() {
        return 8 + (this._ftpSyncAvailable ? 1 : 0);
    }

    _sortableHeader(label, field) {
        const isActive = this._sort.field === field;
        const arrow = isActive ? (this._sort.dir === 'asc' ? '▲' : '▼') : '';
        return `<th class="ecm-th-sortable ${isActive ? 'ecm-sort-active' : ''}" data-sort-field="${field}">${label}<span class="ecm-sort-arrow">${arrow}</span></th>`;
    }

    _applySort() {
        const field = this._sort.field;
        if (!field) return;
        const dir = this._sort.dir === 'asc' ? 1 : -1;
        this._rows.sort((a, b) => {
            const av = a[field] || 0;
            const bv = b[field] || 0;
            if (av === bv) return 0;
            return av < bv ? -dir : dir;
        });
    }

    // "Chọn các bản dịch": với mỗi dòng đang được chọn, tự chọn thêm các bản
    // dịch của nó — nhưng chỉ những bản dịch đang có trong this._rows (tập
    // đã lọc hiện tại). Nếu filter Ngôn ngữ đang thu hẹp danh sách chỉ còn 1
    // ngôn ngữ thì bản dịch (ngôn ngữ khác) sẽ không nằm trong this._rows và
    // không thể tự chọn được — bỏ filter Ngôn ngữ để dùng tính năng này.
    _selectTranslations() {
        const routeIndex = new Set(this._rows.map((r) => r.route));
        Array.from(this._selected).forEach((route) => {
            const row = this._rows.find((r) => r.route === route);
            if (!row || !row.translations) return;
            Object.values(row.translations).forEach((targetRoute) => {
                if (routeIndex.has(targetRoute)) {
                    this._selected.add(targetRoute);
                }
            });
        });
        this._renderRows();
    }

    async _applyBulkAction() {
        const select = this.querySelector('[data-role="bulk-action"]');
        const action = select?.value;
        if (!action) {
            window.alert('Hãy chọn 1 hành động.');
            return;
        }

        const routes = Array.from(this._selected);
        if (routes.length === 0) {
            window.alert('Chưa chọn bài viết nào.');
            return;
        }

        const actionLabel = action === 'delete' ? 'XOÁ' : 'ĐÁNH DẤU PRIVATE';
        if (!window.confirm(`${actionLabel} ${routes.length} bài viết đã chọn? Thao tác xoá không thể hoàn tác.`)) {
            return;
        }

        const applyBtn = this.querySelector('[data-role="apply-bulk"]');
        if (applyBtn) applyBtn.disabled = true;

        const failed = [];
        for (const route of routes) {
            try {
                if (action === 'delete') {
                    await this._fetch(`/pages${route}`, { method: 'DELETE' });
                } else {
                    await this._fetch(`/pages${route}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ header: { private: true } }),
                    });
                }
            } catch (err) {
                failed.push(`${route} (${err.message || 'lỗi'})`);
            }
        }

        if (applyBtn) applyBtn.disabled = false;
        if (failed.length > 0) {
            window.alert(`Hoàn tất với ${failed.length} lỗi:\n${failed.join('\n')}`);
        }
        this._selected.clear();
        this._load();
    }

    _updateSelectAllState() {
        const checkbox = this.querySelector('[data-role="select-all"]');
        if (!checkbox) return;
        if (this._rows.length === 0) {
            checkbox.checked = false;
            checkbox.indeterminate = false;
            return;
        }
        const selectedCount = this._rows.filter((r) => this._selected.has(r.route)).length;
        checkbox.checked = selectedCount === this._rows.length;
        checkbox.indeterminate = selectedCount > 0 && selectedCount < this._rows.length;
    }

    _updateSelectedCount() {
        const el = this.querySelector('[data-role="selected-count"]');
        if (el) el.textContent = this._selected.size > 0 ? `${this._selected.size} đã chọn` : '';
    }

    _renderRows() {
        const tbody = this.querySelector('.ecm-tbody');
        if (!tbody) return;

        if (this._rows.length === 0) {
            tbody.innerHTML = `<tr><td class="ecm-td-empty" colspan="${this._colCount()}">Không có nội dung khớp.</td></tr>`;
            this._updateSelectAllState();
            this._updateSelectedCount();
            return;
        }

        tbody.innerHTML = this._rows.map((row, i) => `
            <tr data-index="${i}">
                <td class="ecm-td-check"><input type="checkbox" class="ecm-row-check" data-route="${this._escape(row.route)}" ${this._selected.has(row.route) ? 'checked' : ''} /></td>
                <td class="ecm-title">
                    <a class="ecm-title-link" href="${this._escape(row.route)}" target="_blank" rel="noopener noreferrer">${this._escape(row.title)}</a>
                </td>
                <td>${this._escape(row.type_label)}</td>
                ${this._slmsActive ? `
                    <td>${this._escape(row.language_label || '—')}</td>
                    <td class="${row.translation === 'OK' ? 'ecm-ok' : 'ecm-missing'}">${this._escape(row.translation || '—')}</td>
                ` : ''}
                <td>${this._escape(row.date)}</td>
                <td>${this._escape(row.modified)}</td>
                ${this._ftpSyncAvailable ? `<td><button type="button" class="ecm-btn" data-action="ftpsync" title="Check FTP Sync">Check</button></td>` : ''}
                <td class="ecm-actions">
                    <a class="ecm-edit-btn" href="${this._escape(APP_BASE)}/pages/edit${this._escape(row.route)}">Sửa</a>
                    <button type="button" class="ecm-delete-btn" data-action="delete">Xoá</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('tr').forEach((trEl) => {
            const row = this._rows[Number(trEl.dataset.index)];
            trEl.querySelector('[data-action="delete"]')?.addEventListener('click', () => this._deleteRow(row, trEl));
            trEl.querySelector('[data-action="ftpsync"]')?.addEventListener('click', () => this._openFtpSyncModal(row.route, row.title));
            const checkbox = trEl.querySelector('.ecm-row-check');
            checkbox?.addEventListener('change', () => {
                if (checkbox.checked) {
                    this._selected.add(row.route);
                } else {
                    this._selected.delete(row.route);
                }
                this._updateSelectAllState();
                this._updateSelectedCount();
            });
        });

        this._updateSelectAllState();
        this._updateSelectedCount();
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
                .ecm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
                .ecm-checkbox-label { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--foreground, #1f2937); cursor: pointer; white-space: nowrap; }
                .ecm-bulk-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
                .ecm-btn { display: inline-block; border: 1px solid var(--border, #e5e7eb); background: var(--card, #fff); border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; color: var(--foreground, #1f2937); }
                .ecm-btn:hover { opacity: 0.8; }
                .ecm-btn-primary { color: #fff; background: var(--primary, #3b82f6); border-color: var(--primary, #3b82f6); }
                .ecm-selected-count { font-size: 13px; font-weight: 600; color: var(--muted-foreground, #6b7280); }
                .ecm-th-check, .ecm-td-check { width: 2rem; text-align: center; }
                .ecm-th-sortable { cursor: pointer; user-select: none; white-space: nowrap; }
                .ecm-th-sortable:hover { color: var(--foreground, #1f2937); }
                .ecm-th-sortable .ecm-sort-arrow { margin-left: 4px; color: var(--muted-foreground, #6b7280); }
                .ecm-th-sortable.ecm-sort-active .ecm-sort-arrow { color: inherit; }
                .ecm-select, .ecm-search { border: 1px solid var(--border, #e5e7eb); border-radius: 6px; padding: 6px 10px; font-size: 13px; background: var(--card, #fff); color: var(--foreground, #1f2937); }
                .ecm-search { flex: 1; min-width: 180px; }
                .ecm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
                .ecm-table th { text-align: left; padding: 8px 10px; color: var(--muted-foreground, #6b7280); font-weight: 600; border-bottom: 1px solid var(--border, #e5e7eb); }
                .ecm-table td { padding: 8px 10px; border-bottom: 1px solid var(--border, #e5e7eb); vertical-align: top; color: var(--foreground, #1f2937); }
                .ecm-td-empty { text-align: center; color: var(--muted-foreground, #6b7280); padding: 24px 10px; }
                .ecm-error { color: var(--destructive, #dc2626); }
                .ecm-title-link { color: var(--foreground, #1f2937); text-decoration: none; font-weight: 500; }
                .ecm-title-link:hover { color: var(--primary, #3b82f6); text-decoration: underline; }
                .ecm-edit-btn, .ecm-delete-btn { display: inline-block; border: 1px solid var(--border, #e5e7eb); background: var(--card, #fff); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; color: var(--foreground, #1f2937); text-decoration: none; }
                .ecm-edit-btn { color: var(--primary, #3b82f6); border-color: var(--primary, #3b82f6); margin-right: 4px; }
                .ecm-delete-btn { color: var(--destructive, #dc2626); border-color: var(--destructive, #dc2626); }
                .ecm-edit-btn:hover, .ecm-delete-btn:hover { opacity: 0.8; }
                .ecm-ok { color: var(--success, #16a34a); }
                .ecm-missing { color: var(--destructive, #dc2626); }
                .ecm-actions { text-align: right; }

                .ecm-ftpsync-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 9999; align-items: center; justify-content: center; }
                .ecm-ftpsync-overlay.ecm-open { display: flex; }
                .ecm-ftpsync-modal { background: var(--card, #fff); border-radius: 8px; width: min(760px, 92vw); max-height: 86vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.25); }
                .ecm-ftpsync-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border, #e5e7eb); }
                .ecm-ftpsync-modal-header h3 { margin: 0; font-size: 15px; color: var(--foreground, #1f2937); }
                .ecm-ftpsync-close { background: none; border: none; font-size: 20px; line-height: 1; cursor: pointer; color: var(--muted-foreground, #6b7280); }
                .ecm-ftpsync-modal-body { padding: 14px 18px; overflow-y: auto; }
                .ecm-ftpsync-modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--border, #e5e7eb); }
                .ecm-ftpsync-status { margin-right: auto; font-size: 13px; color: var(--muted-foreground, #6b7280); }
                .ecm-ftpsync-table { width: 100%; border-collapse: collapse; font-size: 12px; }
                .ecm-ftpsync-table th, .ecm-ftpsync-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border, #e5e7eb); vertical-align: top; color: var(--foreground, #1f2937); }
                .ecm-ftpsync-path { word-break: break-all; }
                .ecm-ftpsync-local-only { color: #1f6fb2; }
                .ecm-ftpsync-host-only { color: #b26a1f; }
                .ecm-ftpsync-newer { color: #1f6fb2; font-weight: 600; }
                .ecm-ftpsync-unknown { color: var(--muted-foreground, #6b7280); }
                .ecm-ftpsync-resolution { width: 100%; border: 1px solid var(--border, #e5e7eb); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
                .ecm-ftpsync-empty { color: var(--muted-foreground, #6b7280); padding: 16px 0; text-align: center; }
            </style>
        `;
    }
}

customElements.define(TAG, EasyContentManagerPage);
