import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExt,
  ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  splitProps,
} from "solid-js";
import { cn } from "~/lib/utils.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface MarkdownEditorProps {
  value?: string;
  onInput?: (value: string) => void;
  placeholder?: string;
  autofocus?: boolean;
  class?: string;
  disabled?: boolean;
  minHeight?: string;
  showToolbar?: boolean;
}

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "14px",
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  ".cm-content": {
    fontFamily: "inherit",
    padding: "8px 12px",
    caretColor: "var(--foreground)",
  },
  ".cm-focused": {
    outline: "none",
  },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-line": {
    color: "var(--foreground)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "none",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--muted)",
  },
});

type InlineStyle = {
  name: string;
  icon: string;
  prefix: string;
  suffix: string;
  placeholder: string;
};

type BlockStyle = {
  name: string;
  icon: string;
  prefix: string;
};

const inlineStyles: InlineStyle[] = [
  {
    name: "Bold",
    icon: "B",
    prefix: "**",
    suffix: "**",
    placeholder: "bold text",
  },
  {
    name: "Italic",
    icon: "I",
    prefix: "_",
    suffix: "_",
    placeholder: "italic text",
  },
  { name: "Code", icon: "<>", prefix: "`", suffix: "`", placeholder: "code" },
  {
    name: "Link",
    icon: "🔗",
    prefix: "[",
    suffix: "](url)",
    placeholder: "link text",
  },
];

const blockStyles: BlockStyle[] = [
  { name: "Heading 1", icon: "H1", prefix: "# " },
  { name: "Heading 2", icon: "H2", prefix: "## " },
  { name: "Heading 3", icon: "H3", prefix: "### " },
  { name: "Quote", icon: ">", prefix: "> " },
  { name: "List", icon: "•", prefix: "- " },
];

// Keyboard shortcuts for formatting
const formattingKeymap: KeyBinding[] = [
  {
    key: "Mod-b",
    run: (view) => {
      applyInlineStyleByName(view, "Bold");
      return true;
    },
  },
  {
    key: "Mod-i",
    run: (view) => {
      applyInlineStyleByName(view, "Italic");
      return true;
    },
  },
  {
    key: "Mod-`",
    run: (view) => {
      applyInlineStyleByName(view, "Code");
      return true;
    },
  },
  {
    key: "Mod-k",
    run: (view) => {
      applyInlineStyleByName(view, "Link");
      return true;
    },
  },
];

function applyInlineStyleByName(view: EditorView, name: string): void {
  const style = inlineStyles.find((s) => s.name === name);
  if (style) {
    applyInlineStyle(view, style);
  }
}

function applyInlineStyle(view: EditorView, style: InlineStyle): void {
  const { state } = view;
  const selection = state.selection.main;

  if (selection.empty) {
    const text = `${style.prefix}${style.placeholder}${style.suffix}`;
    view.dispatch({
      changes: { from: selection.from, insert: text },
      selection: {
        anchor: selection.from + style.prefix.length,
        head: selection.from + style.prefix.length + style.placeholder.length,
      },
    });
  } else {
    const selectedText = state.sliceDoc(selection.from, selection.to);
    const isWrapped = selectedText.startsWith(style.prefix) &&
      selectedText.endsWith(style.suffix);

    if (isWrapped) {
      const unwrapped = selectedText.slice(
        style.prefix.length,
        -style.suffix.length,
      );
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: unwrapped },
        selection: {
          anchor: selection.from,
          head: selection.from + unwrapped.length,
        },
      });
    } else {
      const wrapped = `${style.prefix}${selectedText}${style.suffix}`;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: wrapped },
        selection: {
          anchor: selection.from,
          head: selection.from + wrapped.length,
        },
      });
    }
  }
  view.focus();
}

function applyBlockStyle(view: EditorView, style: BlockStyle): void {
  const { state } = view;
  const selection = state.selection.main;
  const firstLine = state.doc.lineAt(selection.from);
  const lastLine = state.doc.lineAt(selection.to);

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let i = firstLine.number; i <= lastLine.number; i++) {
    const line = state.doc.line(i);
    const lineText = line.text;

    if (lineText.startsWith(style.prefix)) {
      changes.push({
        from: line.from,
        to: line.from + style.prefix.length,
        insert: "",
      });
    } else {
      const existingPrefix = blockStyles.find((s) =>
        lineText.startsWith(s.prefix)
      );
      if (existingPrefix) {
        changes.push({
          from: line.from,
          to: line.from + existingPrefix.prefix.length,
          insert: style.prefix,
        });
      } else {
        changes.push({ from: line.from, to: line.from, insert: style.prefix });
      }
    }
  }

  view.dispatch({ changes });
  view.focus();
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const [local, others] = splitProps(props, [
    "value",
    "onInput",
    "placeholder",
    "autofocus",
    "class",
    "disabled",
    "minHeight",
    "showToolbar",
  ]);

  const { t } = useLingui();

  const labelOf = (name: string): string => {
    switch (name) {
      case "Bold":
        return t`Bold`;
      case "Italic":
        return t`Italic`;
      case "Code":
        return t`Code`;
      case "Link":
        return t`Link`;
      case "Heading 1":
        return t`Heading 1`;
      case "Heading 2":
        return t`Heading 2`;
      case "Heading 3":
        return t`Heading 3`;
      case "Quote":
        return t`Quote`;
      case "List":
        return t`List`;
      default:
        return name;
    }
  };

  let containerRef: HTMLDivElement | undefined;
  const [editorView, setEditorView] = createSignal<EditorView | undefined>();
  const editableCompartment = new Compartment();

  onMount(() => {
    if (!containerRef) return;

    // Dynamic theme for minHeight
    const minHeightTheme = EditorView.theme({
      ".cm-content, .cm-gutter": {
        minHeight: local.minHeight ?? "80px",
      },
      ".cm-scroller": {
        minHeight: local.minHeight ?? "80px",
      },
    });

    const extensions = [
      editorTheme,
      minHeightTheme,
      history(),
      // Formatting keymap first so it takes precedence
      keymap.of(formattingKeymap),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
      }),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      editableCompartment.of(EditorView.editable.of(!local.disabled)),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged && local.onInput) {
          local.onInput(update.state.doc.toString());
        }
      }),
      // Only stop propagation for shortcuts the editor actually handles,
      // so they don't trigger app-level handlers (e.g. sidebar toggle on Mod-b)
      EditorView.domEventHandlers({
        keydown: (event) => {
          const mod = event.ctrlKey || event.metaKey;
          if (mod && ["b", "i", "k", "`"].includes(event.key)) {
            event.stopPropagation();
          }
          return false;
        },
      }),
    ];

    if (local.placeholder) {
      extensions.push(placeholderExt(local.placeholder));
    }

    const state = EditorState.create({
      doc: local.value ?? "",
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef,
    });

    setEditorView(view);

    if (local.autofocus) {
      view.focus();
    }

    // Cleanup
    onCleanup(() => {
      view.destroy();
    });
  });

  // Sync disabled prop changes into the editor
  createEffect(() => {
    const view = editorView();
    if (view) {
      view.dispatch({
        effects: editableCompartment.reconfigure(
          EditorView.editable.of(!local.disabled),
        ),
      });
    }
  });

  // Sync external value prop changes into the editor
  createEffect(() => {
    const view = editorView();
    const newValue = local.value ?? "";
    if (view && view.state.doc.toString() !== newValue) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newValue },
      });
    }
  });

  const handleInlineStyle = (style: InlineStyle) => {
    const view = editorView();
    if (view) {
      applyInlineStyle(view, style);
    }
  };

  const handleBlockStyle = (style: BlockStyle) => {
    const view = editorView();
    if (view) {
      applyBlockStyle(view, style);
    }
  };

  return (
    <div
      class={cn(
        "w-full rounded-md border border-input bg-background text-sm ring-offset-background",
        "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        local.disabled && "cursor-not-allowed opacity-50",
        local.class,
      )}
    >
      <Show when={local.showToolbar}>
        <div class="flex flex-wrap gap-1 border-b border-input p-2">
          <For each={blockStyles}>
            {(style) => (
              <button
                type="button"
                onClick={() => handleBlockStyle(style)}
                disabled={local.disabled}
                class={cn(
                  "flex h-8 w-8 items-center justify-center rounded text-xs font-medium",
                  "hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
                title={labelOf(style.name)}
              >
                {style.icon}
              </button>
            )}
          </For>
          <div class="mx-1 h-8 w-px bg-border" />
          <For each={inlineStyles}>
            {(style) => (
              <button
                type="button"
                onClick={() => handleInlineStyle(style)}
                disabled={local.disabled}
                class={cn(
                  "flex h-8 w-8 items-center justify-center rounded text-xs font-medium",
                  "hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  style.name === "Bold" && "font-bold",
                  style.name === "Italic" && "italic",
                )}
                title={labelOf(style.name)}
              >
                {style.icon}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div
        ref={containerRef}
        style={{
          "min-height": local.minHeight ?? "80px",
        }}
        {...others}
      />
    </div>
  );
}
