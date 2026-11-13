// Strings shown in the jump list. Windows 11 labels, in the user's language.
const GLib = imports.gi.GLib;

const TABLE = {
    pt: {
        tasks: 'Tarefas',
        recent: 'Recente',
        pin: 'Fixar na barra de tarefas',
        unpin: 'Desafixar da barra de tarefas',
        close: 'Fechar janela',
        closeAll: 'Fechar todas as janelas',
        newWindow: 'Nova janela',
    },
    es: {
        tasks: 'Tareas',
        recent: 'Reciente',
        pin: 'Anclar a la barra de tareas',
        unpin: 'Desanclar de la barra de tareas',
        close: 'Cerrar ventana',
        closeAll: 'Cerrar todas las ventanas',
        newWindow: 'Nueva ventana',
    },
    en: {
        tasks: 'Tasks',
        recent: 'Recent',
        pin: 'Pin to taskbar',
        unpin: 'Unpin from taskbar',
        close: 'Close window',
        closeAll: 'Close all windows',
        newWindow: 'New window',
    },
};

function pickLanguage() {
    const names = GLib.get_language_names();
    for (let i = 0; i < names.length; i++) {
        const lang = names[i].split(/[_.@-]/)[0];
        if (TABLE[lang]) return lang;
    }
    return 'en';
}

const LANG = pickLanguage();

function tr(key) {
    return (TABLE[LANG] && TABLE[LANG][key]) || TABLE.en[key] || key;
}

module.exports = { tr };
