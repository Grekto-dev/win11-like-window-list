// Strings shown by the applet itself (the jump list). English is the default; Brazilian Portuguese is
// the other choice, picked in the applet settings (independent of the system language).
// Strings of the settings window come from po/pt_BR.po (see applet.js: configureApplet).

const TABLE = {
    en: {
        tasks: 'Tasks',
        recent: 'Recent',
        pin: 'Pin to taskbar',
        unpin: 'Unpin from taskbar',
        close: 'Close window',
        closeAll: 'Close all windows',
        newWindow: 'New window',
    },
    'pt-BR': {
        tasks: 'Tarefas',
        recent: 'Recente',
        pin: 'Fixar na barra de tarefas',
        unpin: 'Desafixar da barra de tarefas',
        close: 'Fechar janela',
        closeAll: 'Fechar todas as janelas',
        newWindow: 'Nova janela',
    },
};

let current = 'en';

function setLanguage(lang) {
    current = TABLE[lang] ? lang : 'en';
}

function getLanguage() {
    return current;
}

function tr(key) {
    return (TABLE[current] && TABLE[current][key]) || TABLE.en[key] || key;
}

module.exports = { tr, setLanguage, getLanguage };
