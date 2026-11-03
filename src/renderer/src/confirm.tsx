import { useEffect, useState } from "react";

interface Question {
    message: string;
    action: string;
    danger: boolean;
    answer: (yes: boolean) => void;
}

let ask: ((question: Question) => void) | null = null;

/**
 * The app's own yes-or-no dialog, in place of window.confirm, which draws a Windows box over the app.
 * Resolves false when nothing is mounted to ask with, so a missing host never deletes anything.
 */
export function confirm(message: string, { action = "Delete", danger = true }: { action?: string; danger?: boolean } = {}): Promise<boolean> {
    return new Promise((resolve) => (ask ? ask({ message, action, danger, answer: resolve }) : resolve(false)));
}

/** Mounted once per window; shows whatever [confirm] is asking. */
export function ConfirmHost() {
    const [question, setQuestion] = useState<Question | null>(null);

    useEffect(() => {
        ask = (next) => setQuestion((current) => {
            // A second question while one is open answers the first with no.
            current?.answer(false);
            return next;
        });
        return () => {
            ask = null;
        };
    }, []);

    const close = (yes: boolean) => {
        question?.answer(yes);
        setQuestion(null);
    };

    useEffect(() => {
        if (!question) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [question]);

    if (!question) return null;

    return (
        <div className="overlay confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
            <div className="dialog confirm" role="alertdialog" aria-modal="true">
                <div className="dialog-body">
                    <p>{question.message}</p>
                </div>
                <div className="dialog-foot">
                    <button className="btn ghost" onClick={() => close(false)}>Cancel</button>
                    <button className={`btn ${question.danger ? "danger" : "primary"}`} autoFocus onClick={() => close(true)}>{question.action}</button>
                </div>
            </div>
        </div>
    );
}
