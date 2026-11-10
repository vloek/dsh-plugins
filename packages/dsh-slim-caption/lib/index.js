// dsh-slim-caption, host half: nothing runs here. The row only exists so the
// browser half (lib/client.js) is loaded and receives its config.
import z from "@deepseek-ai/schemastery";

export const name = "slim-caption";

export const Config = z.object({
	hideMenu: z.boolean().default(true)
		.description("Скрыть меню «Application / Edit» в заголовке окна."),
	mergeHeader: z.boolean().default(true)
		.description("Поднять строку заголовка беседы в полосу заголовка окна (минус одна строка)."),
	transparentControls: z.boolean().default(true)
		.description("Прозрачный фон у кнопок «свернуть / развернуть / закрыть»."),
	f11Fullscreen: z.boolean().default(true)
		.description("F11 — полноэкранный режим окна (повторное F11 возвращает обратно)."),
	escKeepsFullscreen: z.boolean().default(true)
		.description("Esc не выходит из полноэкранного режима, а работает как обычно (закрывает окна, останавливает генерацию)."),
});

export function apply() {}
