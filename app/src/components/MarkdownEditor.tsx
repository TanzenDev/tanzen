import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, historyKeymap, history, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { marked } from "marked";
import { useTheme } from "../context/ThemeContext.js";

// Minimal light theme — matches the app's slate-100 input palette.
const lightTheme = EditorView.theme({
  "&": {
    background: "rgb(241 245 249)",
    color: "rgb(15 23 42)",
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  ".cm-content": { padding: "0.5rem 0.75rem", caretColor: "rgb(15 23 42)" },
  ".cm-cursor": { borderLeftColor: "rgb(15 23 42)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    background: "rgb(203 213 225)",
  },
  ".cm-activeLine": { background: "transparent" },
  ".cm-gutters": { display: "none" },
  ".cm-placeholder": { color: "rgb(100 116 139)" },
}, { dark: false });

// Dark theme — matches slate-700 inputs.
const darkTheme = EditorView.theme({
  "&": {
    background: "rgb(51 65 85)",
    color: "rgb(255 255 255)",
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  ".cm-content": { padding: "0.5rem 0.75rem", caretColor: "#fff" },
  ".cm-cursor": { borderLeftColor: "#fff" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    background: "rgb(71 85 105)",
  },
  ".cm-activeLine": { background: "transparent" },
  ".cm-gutters": { display: "none" },
  ".cm-placeholder": { color: "rgb(148 163 184)" },
}, { dark: true });

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
}

export function MarkdownEditor({ value, onChange, placeholder = "", minHeight = "9rem" }: Props) {
  const { theme } = useTheme();
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Create editor once on mount.
  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions(theme, placeholder, onChangeRef),
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync external value changes (e.g. form reset or edit-open).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  // Swap theme extensions when theme changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setState(
      EditorState.create({
        doc: view.state.doc.toString(),
        extensions: buildExtensions(theme, placeholder, onChangeRef),
      })
    );
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDark = theme === "dark";
  const tabBase = "px-3 py-1 text-xs font-medium rounded transition-colors";
  const tabActive = isDark
    ? "bg-slate-600 text-white"
    : "bg-white text-slate-900 shadow-sm";
  const tabInactive = isDark
    ? "text-slate-400 hover:text-slate-200"
    : "text-slate-500 hover:text-slate-700";

  return (
    <div className="space-y-1">
      <div className={`flex gap-1 p-1 rounded w-fit ${isDark ? "bg-slate-800" : "bg-slate-200"}`}>
        <button
          type="button"
          className={`${tabBase} ${mode === "edit" ? tabActive : tabInactive}`}
          onClick={() => setMode("edit")}
        >
          Edit
        </button>
        <button
          type="button"
          className={`${tabBase} ${mode === "preview" ? tabActive : tabInactive}`}
          onClick={() => setMode("preview")}
        >
          Preview
        </button>
      </div>

      {/* Editor — kept mounted so CodeMirror state is preserved while previewing */}
      <div
        ref={containerRef}
        style={{ minHeight, display: mode === "edit" ? "block" : "none" }}
        className="rounded ring-offset-0 focus-within:ring-2 focus-within:ring-blue-500"
      />

      {mode === "preview" && (
        <div
          style={{ minHeight }}
          className={`md-preview rounded px-3 py-2 text-sm
            ${isDark
              ? "bg-slate-700 text-slate-100"
              : "bg-slate-100 text-slate-900"}`}
          // marked output is safe here: only the agent author's own prompt is rendered
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: value ? marked(value) as string : '<p class="opacity-40">Nothing to preview</p>' }}
        />
      )}
    </div>
  );
}

function buildExtensions(
  theme: "dark" | "light",
  placeholder: string,
  onChangeRef: React.RefObject<(v: string) => void>,
) {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle),
    EditorView.lineWrapping,
    cmPlaceholder(placeholder),
    theme === "dark" ? [oneDark, darkTheme] : lightTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
    }),
  ];
}
