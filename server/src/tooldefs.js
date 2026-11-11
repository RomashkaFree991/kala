// Tool schemas (no dependencies, also used by mcp-bridge.js)
const S = (props, required = []) => ({ type: 'object', properties: props, required });

const DEFS = [
  { name: 'bash', description: 'Выполнить команду bash на Linux-сервере (cwd = папка проекта). Есть sudo без пароля: можно apt-get install, pip install, npm, gradle, godot, git и т.д. Для долгих серверов/процессов используйте background=true.',
    parameters: S({ command: { type: 'string' }, timeout_sec: { type: 'number', description: 'по умолчанию 900, максимум 7200' }, background: { type: 'boolean', description: 'запустить в фоне, вернуть PID и путь к логу' } }, ['command']) },
  { name: 'install_packages', description: 'Установить программы/библиотеки на сервер (от root). Сам пробует apt → pip → npm и чинит apt при ошибках. Используй, когда чего-то не хватает. Если пакет не найден — найди его через web_search и скачай вручную (download_file + bash).',
    parameters: S({ packages: { type: 'array', items: { type: 'string' }, description: 'имена пакетов, например ["ffmpeg","python3-pip"] или ["requests","numpy"]' }, manager: { type: 'string', enum: ['auto', 'apt', 'pip', 'npm'], description: 'по умолчанию auto' } }, ['packages']) },
  { name: 'read_file', description: 'Прочитать текстовый файл. Путь относительный (от папки проекта) или абсолютный.',
    parameters: S({ path: { type: 'string' }, offset: { type: 'number', description: 'номер первой строки (с 1)' }, limit: { type: 'number', description: 'кол-во строк' } }, ['path']) },
  { name: 'write_file', description: 'Создать или полностью перезаписать файл (папки создаются автоматически).',
    parameters: S({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
  { name: 'edit_file', description: 'Заменить в файле фрагмент old_string на new_string. old_string должен встречаться ровно один раз (или replace_all=true).',
    parameters: S({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']) },
  { name: 'list_dir', description: 'Показать содержимое папки.',
    parameters: S({ path: { type: 'string' }, recursive: { type: 'boolean' } }) },
  { name: 'delete_path', description: 'Удалить файл или папку (рекурсивно).', parameters: S({ path: { type: 'string' } }, ['path']) },
  { name: 'move_path', description: 'Переместить/переименовать файл или папку.', parameters: S({ from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']) },
  { name: 'web_fetch', description: 'HTTP-запрос в интернет (GET/POST/...). Возвращает статус и тело (HTML упрощается до текста, если as_text=true).',
    parameters: S({ url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' }, as_text: { type: 'boolean' } }, ['url']) },
  { name: 'web_search', description: 'Поиск в интернете (DuckDuckGo). Возвращает заголовки, ссылки и описания.',
    parameters: S({ query: { type: 'string' } }, ['query']) },
  { name: 'download_file', description: 'Скачать файл из интернета на сервер.', parameters: S({ url: { type: 'string' }, path: { type: 'string' } }, ['url', 'path']) },
  { name: 'view_image', description: 'Посмотреть изображение с сервера (png/jpg/webp/gif) — оно будет показано вам и пользователю.', parameters: S({ path: { type: 'string' } }, ['path']) },
  { name: 'send_file', description: 'Отправить файл с сервера пользователю в чат (кнопка скачать на телефон). Например готовый APK.', parameters: S({ path: { type: 'string' } }, ['path']) },
  { name: 'phone_take_photo', description: 'Сделать фото камерой телефона пользователя (пользователь нажмёт на кнопку съёмки). Фото сохраняется в проект и показывается вам.',
    parameters: S({ camera: { type: 'string', enum: ['back', 'front'] }, save_as: { type: 'string', description: 'путь на сервере, по умолчанию photos/photo_<время>.jpg' } }) },
  { name: 'phone_list_files', description: 'Список файлов в папке на телефоне. Корень всей памяти: /storage/emulated/0 (Download, DCIM, Documents, Pictures, Android…). Доступны только разрешённые папки.', parameters: S({ path: { type: 'string', description: 'по умолчанию /storage/emulated/0' } }) },
  { name: 'phone_read_file', description: 'Прочитать текстовый файл с телефона.', parameters: S({ path: { type: 'string' } }, ['path']) },
  { name: 'phone_write_file', description: 'Записать текстовый файл на телефон.', parameters: S({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
  { name: 'phone_to_server', description: 'Скопировать файл (любой, в т.ч. бинарный) с телефона на сервер.', parameters: S({ phone_path: { type: 'string' }, server_path: { type: 'string' } }, ['phone_path', 'server_path']) },
  { name: 'server_to_phone', description: 'Скопировать файл с сервера на телефон.', parameters: S({ server_path: { type: 'string' }, phone_path: { type: 'string' } }, ['server_path', 'phone_path']) },
  { name: 'phone_find', description: 'Найти файлы на телефоне по части имени (рекурсивно), например "*.apk", "report", ".jpg". По умолчанию ищет во всей разрешённой памяти.',
    parameters: S({ query: { type: 'string' }, path: { type: 'string', description: 'где искать, по умолчанию /storage/emulated/0' }, limit: { type: 'number' } }, ['query']) },
  { name: 'phone_delete', description: 'Удалить файл/папку на телефоне.', parameters: S({ path: { type: 'string' } }, ['path']) },
];

module.exports = { DEFS };
