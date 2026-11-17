# Плагины для DeepSeek Harness

Четыре небольших плагина для десктопного DeepSeek Harness (DSH). Написаны без сборки: обычный JavaScript, React берётся из самого приложения. Ставятся по отдельности или все сразу.

| Плагин | Что делает | Где работает |
|---|---|---|
| [dsh-task-board](packages/dsh-task-board) | Доска приёмки задач. ИИ кладёт задачу со скриншотами и видео, ты проверяешь и жмёшь «Принять» или «На доработку», ИИ видит решение и действует дальше. Подходит и для агента внутри DSH, и для любого внешнего ИИ с доступом к файлам | Windows, macOS, Linux |
| [dsh-quick-switch](packages/dsh-quick-switch) | Ctrl+Space открывает палитру сессий с нечётким поиском по названию. Alt+1…9 открывают панели левого сайдбара | Windows, macOS, Linux |
| [dsh-compact-rail](packages/dsh-compact-rail) | Возвращает узкую полосу иконок: Ctrl+B сворачивает левый сайдбар до 56px, а не прячет его целиком | десктоп под Windows |
| [dsh-slim-caption](packages/dsh-slim-caption) | Компактный заголовок окна и полноэкранный режим по F11 | десктоп под Windows |

Плагины для Windows на других системах ничего не ломают: они проверяют оболочку и просто не включаются.

## Установка

Нужен [Node.js](https://nodejs.org) 20 или новее.

1. Скачай репозиторий: кнопка **Code → Download ZIP** на GitHub или

   ```bash
   git clone https://github.com/vloek/dsh-plugins.git
   ```

2. Закрой DeepSeek Harness.
3. В папке репозитория выполни:

   ```bash
   node scripts/install.mjs
   ```

4. Запусти DeepSeek Harness.

Скрипт ставит все четыре плагина в профиль `~/.dsh/profiles/desktop` (на Windows это `C:\Users\<имя>\.dsh\profiles\desktop`). Перед правкой он сохраняет копию `package.json` профиля рядом с оригиналом.

Только выбранные плагины:

```bash
node scripts/install.mjs dsh-task-board dsh-quick-switch
```

Другой профиль или нестандартная папка DSH:

```bash
node scripts/install.mjs --profile /путь/к/профилю
```

Посмотреть, что есть в репозитории:

```bash
node scripts/install.mjs --list
```

### Обновление

Скачай свежую версию репозитория и снова запусти `node scripts/install.mjs`. Скрипт заменит плагины новыми версиями.

### Удаление

```bash
node scripts/install.mjs --uninstall
```

Можно указать имена, чтобы убрать только часть плагинов. Данные доски задач (`~/.dsh/task-board`) скрипт не трогает.

### Установка вручную

Если запускать скрипт не хочется, то же самое делается руками. Для каждого плагина:

1. Скопируй `dist/<плагин>-<версия>.tgz` в папку `local-plugins` своего профиля (создай её, если нет).
2. В `package.json` профиля добавь строку в `dependencies`:

   ```json
   "dsh-task-board": "file:local-plugins/dsh-task-board-0.5.0.tgz"
   ```

   и имя плагина в массив `dsh.profile.bundles`.
3. Распакуй содержимое папки `package` из архива в `node_modules/<плагин>` профиля.
4. Перезапусти DeepSeek Harness.

## Настройка

У каждого плагина свои настройки, они описаны в его README. Меняются в файле `cordis.patch.yml` профиля, например:

```yaml
- id: task-board
  config:
    root: D:/projects/my-app/.review
```

## Разработка

```bash
node scripts/test.mjs        # тесты всех плагинов, без запуска DSH
node scripts/build-dist.mjs  # пересобрать dist/*.tgz после правок
```

Каждый плагин лежит в `packages/<имя>`: `lib/index.js` работает в процессе хоста DSH, `lib/client.js` — в окне приложения. После правки подними версию в `package.json` плагина, пересобери архивы и запусти установку.

Плагины опираются на внутренние имена CSS-классов и сервисов DSH. Хэши классов они читают на лету, но крупное обновление приложения всё равно может что-то сломать.

## Лицензия

MIT, см. [LICENSE](LICENSE).
