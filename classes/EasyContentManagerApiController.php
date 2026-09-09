<?php

declare(strict_types=1);

namespace Grav\Plugin\EasyContentManager\Api;

use Grav\Common\Page\Interfaces\PageInterface;
use Grav\Common\Page\Pages;
use Grav\Plugin\Api\Controllers\AbstractApiController;
use Grav\Plugin\Api\Exceptions\ValidationException;
use Grav\Plugin\Api\Response\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Admin2 backend for Easy Content Manager's content list.
 *
 * Ported from EasyContentManagerPlugin::handleListContent() (the
 * admin-classic onAdminTaskExecute handler). Kept as a dedicated endpoint
 * rather than the generic GET /pages listing because the cross-cutting
 * query here — approved-template allowlist, SLMS-aware language filter,
 * title token-overlap scoring, live translation-completeness check — has
 * no equivalent among the generic filters. Deletion is NOT re-implemented
 * here: the web component calls the generic DELETE /pages/{route} instead,
 * since the classic handler's multi-language-aware delete is exactly what
 * that endpoint already does for Grav's native per-page translations.
 */
class EasyContentManagerApiController extends AbstractApiController
{
    private const PERMISSION_READ = 'api.pages.read';

    /**
     * GET /easy-content-manager/rows — list + filter + search content.
     */
    public function rows(ServerRequestInterface $request): ResponseInterface
    {
        $this->requirePermission($request, self::PERMISSION_READ);

        $query = $request->getQueryParams();
        $type = trim((string) ($query['type'] ?? ''));
        $language = trim((string) ($query['language'] ?? ''));
        $search = trim((string) ($query['q'] ?? ''));
        $privateOnly = !empty($query['private_only']);

        $slms = $this->slmsInfo();
        $allowedTemplates = $this->allowedTemplates();
        $typeLabels = Pages::types();

        $typeOptions = [];
        foreach ($allowedTemplates as $slug) {
            $typeOptions[$slug] = $typeLabels[$slug] ?? $slug;
        }
        asort($typeOptions);

        if (empty($allowedTemplates)) {
            return ApiResponse::create([
                'rows' => [],
                'slms_active' => $slms['active'],
                'language_options' => $slms['languages'],
                'type_options' => $typeOptions,
            ]);
        }

        $pages = $this->grav['pages'];
        $pages->enablePages();

        $rows = [];
        foreach ($pages->all() as $page) {
            if (!$page instanceof PageInterface) {
                continue;
            }

            $template = $page->template();
            if (!in_array($template, $allowedTemplates, true)) {
                continue;
            }
            if ($type !== '' && $type !== $template) {
                continue;
            }
            if ($privateOnly && empty($page->header()->private)) {
                continue;
            }

            $pageLanguage = null;
            $translationStatus = null;
            $translationRoutes = [];
            if ($slms['active']) {
                $pageLanguage = $this->slmsPageLanguage($page, $slms);
                if ($language !== '' && $language !== $pageLanguage) {
                    continue;
                }
                $translationStatus = $this->slmsTranslationStatus($page, $pageLanguage, $slms);
                $translationRoutes = $this->slmsTranslationRoutes($page, $pageLanguage, $slms);
            }

            $title = (string) $page->title();

            $score = 1;
            if ($search !== '') {
                $score = $this->searchScore($title, $search);
                if ($score <= 0) {
                    continue;
                }
            }

            $rows[] = [
                'score' => $score,
                'type' => $template,
                'type_label' => $typeLabels[$template] ?? $template,
                'language' => $pageLanguage,
                'language_label' => $pageLanguage !== null ? ($slms['languages'][$pageLanguage] ?? $pageLanguage) : null,
                'translation' => $translationStatus,
                'translations' => $translationRoutes,
                'title' => $title,
                'date' => date('Y-m-d', $page->date()),
                'date_ts' => $page->date(),
                'modified' => date('Y-m-d', $page->modified()),
                'modified_ts' => $page->modified(),
                'route' => '/' . ltrim((string) $page->rawRoute(), '/'),
            ];
        }

        usort($rows, static function (array $a, array $b): int {
            if ($a['score'] !== $b['score']) {
                return $b['score'] <=> $a['score'];
            }

            return strcasecmp($a['title'], $b['title']);
        });

        return ApiResponse::create([
            'rows' => $rows,
            'slms_active' => $slms['active'],
            'language_options' => $slms['languages'],
            'type_options' => $typeOptions,
            'ftp_sync_available' => $this->ftpSyncPluginAvailable() && $this->isFtpSyncCapableUser($request),
        ]);
    }

    /**
     * POST /easy-content-manager/ftp-sync/check — diff riêng thư mục của 1
     * trang (route trong body) so với hosting, dùng cho nút "Check FTP
     * Sync" theo từng dòng trong bảng content. Forward sang
     * FtpSync\SyncManager::checkPathDiff() (xem docblock ở đó) — không có
     * logic diff riêng ở đây.
     */
    public function ftpSyncCheck(ServerRequestInterface $request): ResponseInterface
    {
        $this->ftpSyncGuard($request);

        $body = $this->getRequestBody($request);
        $route = '/' . ltrim((string) ($body['route'] ?? ''), '/');
        if ($route === '/') {
            throw new ValidationException('Missing route.');
        }

        [$localDir, $remoteDir] = $this->ftpSyncPathsForRoute($route);

        try {
            $rows = $this->ftpSyncManager()->checkPathDiff($localDir, $remoteDir);
        } catch (\RuntimeException $e) {
            throw new ValidationException($e->getMessage());
        }

        return ApiResponse::create(['rows' => $rows]);
    }

    /**
     * POST /easy-content-manager/ftp-sync/apply — áp dụng resolution đã
     * chọn (trong popup "Check FTP Sync") cho thư mục của 1 trang. Forward
     * sang FtpSync\SyncManager::applyPathResolutions().
     */
    public function ftpSyncApply(ServerRequestInterface $request): ResponseInterface
    {
        $this->ftpSyncGuard($request);

        $body = $this->getRequestBody($request);
        $route = '/' . ltrim((string) ($body['route'] ?? ''), '/');
        if ($route === '/') {
            throw new ValidationException('Missing route.');
        }
        $resolutions = (array) ($body['resolutions'] ?? []);

        [$localDir, $remoteDir] = $this->ftpSyncPathsForRoute($route);

        try {
            $result = $this->ftpSyncManager()->applyPathResolutions($localDir, $remoteDir, $resolutions);
        } catch (\RuntimeException $e) {
            throw new ValidationException($e->getMessage());
        }

        \Grav\Common\Cache::clearCache('invalidate');

        return ApiResponse::create($result);
    }

    /**
     * Gate cho cả 2 endpoint FTP Sync ở trên: api.super (dữ liệu FTP nhạy
     * cảm — cấu trúc file + timestamp trên hosting — không phải quyền đọc
     * content thông thường, giống hệt cách chính plugin ftp-sync tự gate
     * MỌI thao tác của nó, kể cả "Check differences" chỉ đọc, bằng
     * admin.super/api.super), cộng điều kiện plugin ftp-sync có cài + bật +
     * đang chạy local (isEnabled()).
     */
    private function ftpSyncGuard(ServerRequestInterface $request): void
    {
        $this->requireSuper($request);

        if (!$this->ftpSyncPluginAvailable()) {
            throw new ValidationException('FTP Sync plugin is not available (not installed, not enabled, or not a local environment).');
        }
    }

    /**
     * Không throw — dùng để tính flag 'ftp_sync_available' trả về cho UI
     * (ẩn/hiện nút Check FTP Sync), tách khỏi ftpSyncGuard() (dùng để CHẶN
     * request).
     *
     * QUAN TRỌNG: $this->grav['plugins']->get($name) (instance method trên
     * service Plugins) trả về Data — object CONFIG đọc từ blueprint, KHÔNG
     * PHẢI instance thật của plugin — nên không có method isEnabled().
     * Dùng \Grav\Common\Plugins::getPlugin() (static) mới đúng — trả về
     * chính instance FTPSyncPlugin đã khởi tạo (xem Plugins::getPlugins(),
     * key theo $instance->name).
     */
    private function ftpSyncPluginAvailable(): bool
    {
        if (!$this->config->get('plugins.ftp-sync.enabled', true)) {
            return false;
        }

        $plugin = \Grav\Common\Plugins::getPlugin('ftp-sync');
        if ($plugin === null || !method_exists($plugin, 'isEnabled') || !$plugin->isEnabled()) {
            return false;
        }

        return class_exists('Grav\\Plugin\\FtpSync\\SyncManager');
    }

    /**
     * Không throw — bản bool của requireSuper(), chỉ dùng để tính flag hiển
     * thị UI (xem ftpSyncPluginAvailable()), KHÔNG thay thế ftpSyncGuard() ở
     * 2 endpoint check/apply (những nơi đó vẫn gọi requireSuper() trực tiếp
     * để có throw + message rõ ràng).
     *
     * QUAN TRỌNG: KHÔNG gọi thẳng $user->authorize('admin.super') — user
     * nạp qua API key/JWT (ApiKeyAuthenticator::authenticate() chỉ
     * $accounts->load($username), không phải flow đăng nhập thật) không có
     * property runtime authenticated/authorized được set, mà
     * Flex\Types\Users\UserObject::authorize() bắt buộc 2 cờ đó phải true
     * mới đi tiếp — nên authorize() luôn trả false dù account thật sự có
     * admin.super/api.super (đã xác nhận qua debug thực tế). requireSuper()
     * (qua PermissionResolver) không phụ thuộc 2 cờ đó nên dùng được.
     */
    private function isFtpSyncCapableUser(ServerRequestInterface $request): bool
    {
        try {
            $this->requireSuper($request);

            return true;
        } catch (\Throwable $e) {
            return false;
        }
    }

    /**
     * @return array{0:string,1:string} [localDir, remoteDir] tuyệt đối cho
     * thư mục của 1 trang — localDir = $page->path() (đã đúng là folder
     * trang), remoteDir = remote_base_path (config ftp-sync) + user/pages +
     * phần đường dẫn còn lại sau PAGES_DIR.
     */
    private function ftpSyncPathsForRoute(string $route): array
    {
        $pages = $this->grav['pages'];
        $pages->enablePages();
        $page = $pages->find($route, true);
        if (!$page) {
            throw new ValidationException('Content not found.');
        }

        $localDir = rtrim((string) $page->path(), '/');
        $relPath = ltrim(str_replace(rtrim(PAGES_DIR, '/'), '', $localDir), '/');

        $remoteBase = rtrim((string) $this->config->get('plugins.ftp-sync.remote_base_path', '/'), '/');
        $remoteDir = $remoteBase . '/user/pages/' . $relPath;

        return [$localDir, $remoteDir];
    }

    private function ftpSyncManager(): \Grav\Plugin\FtpSync\SyncManager
    {
        $config = (array) $this->config->get('plugins.ftp-sync');
        $config['active_theme'] = (string) $this->config->get('system.pages.theme', '');

        return new \Grav\Plugin\FtpSync\SyncManager($config, DATA_DIR . 'ftp-sync');
    }

    /** @return array<int, string> slug template đã tick trong config plugin, dùng dropdown "Content type" + lọc bảng. */
    private function allowedTemplates(): array
    {
        $templates = (array) $this->config->get('plugins.easy-content-manager.templates', []);

        return array_keys(array_filter($templates));
    }

    /** @return array{active: bool, languages: array<string, string>, default_language: string} */
    private function slmsInfo(): array
    {
        $ourToggle = (bool) $this->config->get('plugins.easy-content-manager.enable_slms', false);
        $installed = $this->grav['plugins']->get('simple-multi-language-site') !== null;
        $pluginEnabled = (bool) $this->config->get('plugins.simple-multi-language-site.enabled', false);

        $languagesRaw = (array) $this->config->get('plugins.simple-multi-language-site.languages', []);
        $languages = [];
        foreach ($languagesRaw as $entry) {
            $code = trim((string) ($entry['code'] ?? ''));
            if ($code === '') {
                continue;
            }
            $languages[$code] = trim((string) ($entry['label'] ?? $code));
        }

        $defaultLanguage = trim((string) $this->config->get('plugins.simple-multi-language-site.default_language', ''));
        if ($defaultLanguage === '' || !isset($languages[$defaultLanguage])) {
            $keys = array_keys($languages);
            $defaultLanguage = $keys[0] ?? '';
        }

        return [
            'active' => $ourToggle && $installed && $pluginEnabled && count($languages) > 0,
            'languages' => $languages,
            'default_language' => $defaultLanguage,
        ];
    }

    private function slmsPageLanguage(PageInterface $page, array $slms): string
    {
        $code = trim((string) ($page->header()->smls_language ?? ''));
        if ($code !== '' && isset($slms['languages'][$code])) {
            return $code;
        }

        return $slms['default_language'];
    }

    private function slmsTranslationStatus(PageInterface $page, string $pageLanguage, array $slms): string
    {
        $translations = (array) ($page->header()->smls_translations ?? []);
        $pages = $this->grav['pages'];

        $missing = [];
        foreach ($slms['languages'] as $code => $label) {
            if ($code === $pageLanguage) {
                continue;
            }
            $route = trim((string) ($translations[$code] ?? ''));
            $target = $route !== '' ? $pages->find($route) : null;
            if (!$target) {
                $missing[] = $label;
            }
        }

        if (empty($missing)) {
            return 'OK';
        }

        return 'Thiếu bản dịch: ' . implode(', ', $missing);
    }

    /**
     * @return array<string, string> code => route (chỉ những bản dịch có
     * trang đích thực sự tồn tại), dùng cho nút "Chọn các bản dịch" ở phía
     * client (khớp route này với các dòng đang hiển thị trong bảng).
     */
    private function slmsTranslationRoutes(PageInterface $page, string $pageLanguage, array $slms): array
    {
        $translations = (array) ($page->header()->smls_translations ?? []);
        $pages = $this->grav['pages'];

        $routes = [];
        foreach ($slms['languages'] as $code => $label) {
            if ($code === $pageLanguage) {
                continue;
            }
            $route = trim((string) ($translations[$code] ?? ''));
            $target = $route !== '' ? $pages->find($route) : null;
            if ($target) {
                $routes[$code] = '/' . ltrim((string) $target->rawRoute(), '/');
            }
        }

        return $routes;
    }

    private function searchScore(string $title, string $query): int
    {
        $normalizedTitle = mb_strtolower($title, 'UTF-8');
        $normalizedQuery = mb_strtolower($query, 'UTF-8');

        $words = preg_split('/\s+/u', $normalizedQuery, -1, PREG_SPLIT_NO_EMPTY);
        if (empty($words)) {
            return 0;
        }

        $score = 0;
        foreach ($words as $word) {
            if (mb_stripos($normalizedTitle, $word, 0, 'UTF-8') !== false) {
                $score++;
            }
        }

        if ($score > 0 && mb_stripos($normalizedTitle, $normalizedQuery, 0, 'UTF-8') !== false) {
            $score++;
        }

        return $score;
    }
}
