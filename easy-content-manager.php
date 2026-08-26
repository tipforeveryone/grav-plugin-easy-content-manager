<?php

namespace Grav\Plugin;

use Grav\Common\Cache;
use Grav\Common\Filesystem\Folder;
use Grav\Common\Page\Interfaces\PageInterface;
use Grav\Common\Page\Pages;
use Grav\Common\Plugin;
use RocketTheme\Toolbox\Event\Event;

/**
 * Easy Content Manager
 *
 * Dedicated Admin Panel page listing content across approved templates
 * (configured in this plugin's own settings) with a title search, type
 * filter, and — when the "Simple Multi Language Site" (SLMS) plugin is
 * installed and enabled — a language filter plus translation-completeness
 * column. Reads SLMS's header fields (smls_language/smls_translations)
 * directly instead of depending on its classes, so this plugin still works
 * fine (minus the language features) when SLMS is absent.
 */
class EasyContentManagerPlugin extends Plugin
{
    public static function getSubscribedEvents()
    {
        return [
            'onPluginsInitialized' => ['onPluginsInitialized', 0],
        ];
    }

    public function onPluginsInitialized(): void
    {
        if (!$this->isAdmin()) {
            return;
        }

        $this->enable([
            'onAdminMenu' => ['onAdminMenu', 0],
            'onAdminTwigTemplatePaths' => ['onAdminTwigTemplatePaths', 0],
            'onAdminTaskExecute' => ['onAdminTaskExecute', 0],
            'onTwigInitialized' => ['onTwigInitialized', 0],
            'onOutputGenerated' => ['onOutputGenerated', 0],
        ]);
    }

    /**
     * Field "templates" (type: checkboxes) render mỗi option là 1 cặp
     * <input>+<label> rời rạc trong <div class="checkboxes">, xuống dòng
     * theo flow tự nhiên của trình duyệt — lộn xộn khi có nhiều template.
     * Giống cách simple-multi-language-site làm với "multilang_templates":
     * không sửa template của plugin "form" (vendored), chỉ inject 1 đoạn
     * CSS nhỏ scope theo class "ecm-templates-grid" (wrapper_classes trong
     * blueprints.yaml) xếp lại thành lưới đều.
     */
    public function onOutputGenerated(): void
    {
        $output = $this->grav->output;
        if (strpos($output, '</head>') === false) {
            return;
        }

        $style = '<style>'
            . '.checkboxes.ecm-templates-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.5rem 1rem;}'
            . '.checkboxes.ecm-templates-grid label{margin:0;}'
            . '</style>';

        $this->grav->output = str_replace('</head>', $style . "\n</head>", $output);
    }

    public function onAdminMenu(): void
    {
        if (!$this->canManage()) {
            return;
        }

        $this->grav['twig']->plugins_hooked_nav['Content Manager'] = [
            'route' => 'easy-content-manager',
            'icon' => 'fa-list',
            'authorize' => ['admin.super'],
            'priority' => 85,
        ];
    }

    public function onAdminTwigTemplatePaths(Event $event): void
    {
        $paths = $event['paths'];
        $paths[] = __DIR__ . '/admin/templates';
        $event['paths'] = $paths;
    }

    public function onTwigInitialized(): void
    {
        $twig = $this->grav['twig']->twig();
        $twig->addFunction(new \Twig\TwigFunction('ecm_template_options', [$this, 'twigTemplateOptions']));
        $twig->addFunction(new \Twig\TwigFunction('ecm_slms_active', [$this, 'twigSlmsActive']));
        $twig->addFunction(new \Twig\TwigFunction('ecm_language_options', [$this, 'twigLanguageOptions']));
    }

    /** Callback tĩnh dùng bởi field checkboxes "Template được duyệt hiển thị" (data-options@). */
    public static function getTemplateOptions(): array
    {
        return Pages::types();
    }

    /** @return array<string, string> slug => label, chỉ những template đã được tick trong Admin config VÀ vẫn tồn tại. */
    public function twigTemplateOptions(): array
    {
        $allowed = $this->allowedTemplates();
        $labels = Pages::types();

        $options = [];
        foreach ($allowed as $slug) {
            $options[$slug] = $labels[$slug] ?? $slug;
        }
        asort($options);

        return $options;
    }

    public function twigSlmsActive(): bool
    {
        return $this->slmsInfo()['active'];
    }

    /** @return array<string, string> code => label */
    public function twigLanguageOptions(): array
    {
        return $this->slmsInfo()['languages'];
    }

    public function onAdminTaskExecute(Event $event): void
    {
        $controller = $event['controller'];
        $task = $controller->task ?? '';

        if ($task === 'ecmlistcontent') {
            $event->stopPropagation();
            $this->handleListContent($controller->post ?? []);
        } elseif ($task === 'ecmdeletecontent') {
            $event->stopPropagation();
            $this->handleDeleteContent($controller->post ?? []);
        }
    }

    /**
     * Trả về JSON danh sách content đã lọc theo Content type + Language +
     * search box (token-overlap scoring theo tiêu đề — xem searchScore()),
     * sắp xếp theo score giảm dần rồi title tăng dần.
     */
    private function handleListContent(array $post): void
    {
        if (!$this->canManage()) {
            $this->jsonError('Not authorized.');

            return;
        }

        try {
            $type = trim((string) ($post['type'] ?? ''));
            $language = trim((string) ($post['language'] ?? ''));
            $query = trim((string) ($post['q'] ?? ''));

            $allowedTemplates = $this->allowedTemplates();
            if (empty($allowedTemplates)) {
                $this->grav['admin']->json_response = ['status' => 'success', 'rows' => [], 'slms_active' => $this->slmsInfo()['active']];

                return;
            }

            $typeLabels = Pages::types();
            $slms = $this->slmsInfo();

            // Admin không tự build cây trang trên mỗi request (để đỡ tốn hiệu
            // năng cho các màn hình admin không cần đến toàn bộ pages) — phải
            // gọi enablePages() trước thì ->all() mới trả về đúng danh sách,
            // giống hệt cách core AdminController::taskFilterPages() làm qua
            // Admin::enablePages().
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

                $pageLanguage = null;
                $translationStatus = null;
                if ($slms['active']) {
                    $pageLanguage = $this->slmsPageLanguage($page, $slms);
                    if ($language !== '' && $language !== $pageLanguage) {
                        continue;
                    }
                    $translationStatus = $this->slmsTranslationStatus($page, $pageLanguage, $slms);
                }

                $title = (string) $page->title();

                $score = 1;
                if ($query !== '') {
                    $score = $this->searchScore($title, $query);
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
                    'title' => $title,
                    'date' => date('Y-m-d', $page->date()),
                    'slug' => '/' . ltrim((string) $page->route(), '/'),
                    'route' => '/' . ltrim((string) $page->rawRoute(), '/'),
                    'edit_url' => $this->pageEditUrl($page),
                ];
            }

            usort($rows, static function (array $a, array $b): int {
                if ($a['score'] !== $b['score']) {
                    return $b['score'] <=> $a['score'];
                }

                return strcasecmp($a['title'], $b['title']);
            });

            $this->grav['admin']->json_response = [
                'status' => 'success',
                'rows' => $rows,
                'slms_active' => $slms['active'],
            ];
        } catch (\Throwable $e) {
            $this->jsonError($e->getMessage());
        }
    }

    private function handleDeleteContent(array $post): void
    {
        if (!$this->canManage()) {
            $this->jsonError('Not authorized.');

            return;
        }

        $route = '/' . ltrim((string) ($post['route'] ?? ''), '/');
        if ($route === '/') {
            $this->jsonError('Missing route.');

            return;
        }

        $pages = $this->grav['pages'];
        $pages->enablePages();

        $page = $pages->find($route, true);
        if (!$page) {
            $this->jsonError('Content not found.');

            return;
        }

        try {
            if (count($page->translatedLanguages()) > 1) {
                $page->file()->delete();
            } else {
                Folder::delete($page->path());
            }

            Cache::clearCache('invalidate');

            $this->grav['admin']->json_response = ['status' => 'success'];
        } catch (\Throwable $e) {
            $this->jsonError($e->getMessage());
        }
    }

    /** @return array<int, string> danh sách slug template đã được tick trong Admin config (field "templates", use: keys). */
    private function allowedTemplates(): array
    {
        $templates = (array) $this->config->get('plugins.easy-content-manager.templates', []);

        return array_keys(array_filter($templates));
    }

    /**
     * @return array{active: bool, languages: array<string, string>, default_language: string}
     */
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

    /** Ưu tiên header.smls_language; trang cũ chưa gán thì rơi về default_language (không đoán theo root_path — đơn giản hoá, không phụ thuộc lớp LanguageManager của SLMS). */
    private function slmsPageLanguage(PageInterface $page, array $slms): string
    {
        $code = trim((string) ($page->header()->smls_language ?? ''));
        if ($code !== '' && isset($slms['languages'][$code])) {
            return $code;
        }

        return $slms['default_language'];
    }

    /**
     * "OK" nếu đủ bản dịch cho mọi ngôn ngữ khác đã cấu hình, ngược lại liệt
     * kê tên các ngôn ngữ còn thiếu. Không chỉ kiểm tra field
     * smls_translations có giá trị hay không — route khai báo có thể là 1
     * link mồ côi (trang đích đã bị xoá/đổi tên) — phải xác nhận trang đích
     * THẬT SỰ còn tồn tại thì mới tính là đã có bản dịch.
     */
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
     * Thuật toán search box (token-overlap scoring) — xem canvas
     * "Grav plugin - Easy Content Manager": match substring cho từng từ
     * trong query (không phân biệt hoa/thường, giữ nguyên dấu tiếng Việt),
     * +1 bonus nếu cả cụm query khớp nguyên văn liền nhau trong title.
     */
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

    private function pageEditUrl(PageInterface $page): string
    {
        /** @var \Grav\Plugin\Admin $admin */
        $admin = $this->grav['admin'];

        return $admin->getAdminRoute('/pages' . $page->rawRoute(), $page->language())->toString(true);
    }

    private function canManage(): bool
    {
        $user = $this->grav['user'] ?? null;
        if (!$user || !$user->authenticated) {
            return false;
        }

        return $user->authorize('admin.super') === true;
    }

    private function jsonError(string $message): void
    {
        $this->grav['admin']->json_response = ['status' => 'error', 'message' => $message];
    }
}
