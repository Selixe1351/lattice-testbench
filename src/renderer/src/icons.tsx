/** Inline icons, so the app ships no icon font and draws nothing it did not have to. */

export function Logo({ size = 22 }: { size?: number }) {
    // The license dashboard's mark: four nodes on a 24-unit grid.
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
            <g stroke="currentColor" strokeOpacity=".55" strokeWidth="1.6" strokeLinecap="round">
                <path d="M6 6h12M6 6v12M18 6v12M6 18h12M6 6l12 12" />
            </g>
            <g fill="currentColor">
                <circle cx="6" cy="6" r="2.6" />
                <circle cx="18" cy="6" r="2.6" />
                <circle cx="6" cy="18" r="2.6" />
                <circle cx="18" cy="18" r="2.6" />
            </g>
        </svg>
    );
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={d} />
        </svg>
    );
}

export const Plus = () => <Icon d="M12 5v14M5 12h14" />;
export const Gear = () => <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />;
export const Terminal = () => <Icon d="M4 17l6-6-6-6M12 19h8" />;
export const Split = () => <Icon d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM12 4v16" />;
export const Folder =() => <Icon d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />;
export const FileIcon = () => <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />;
export const Bot = () => <Icon d="M12 8V4H8M4 12h16M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM9 15h.01M15 15h.01" />;
export const Server = () => <Icon size={40} d="M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM7 7.5h.01M7 16.5h.01" />;
export const Trash = () => <Icon d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />;
export const Clock = () => <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2" />;
export const Play = () => <Icon d="M6 4l14 8-14 8z" />;
export const Stop = () => <Icon d="M6 6h12v12H6z" />;
export const Restart = () => <Icon d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />;
export const Kill = () => <Icon d="M13 2L4 14h7l-1 8 9-12h-7z" />;
export const External = () => <Icon d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />;

export const Search = () => <Icon d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" />;
export const Close = () => <Icon size={14} d="M18 6L6 18M6 6l12 12" />;
export const FilePlus = () => <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6M9 15h6" />;
export const FolderPlus = () => <Icon d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2zM12 11v6M9 14h6" />;
export const Upload = () => <Icon d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />;
export const Download = () => <Icon d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />;
export const Diff = () => <Icon d="M12 3v14M5 10h14M5 21h14" />;
export const Pencil = () => <Icon size={14} d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />;
export const Activity = () => <Icon d="M22 12h-4l-3 9L9 3l-3 9H2" />;
export const Globe = () => <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />;
export const Lock = () => <Icon d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4" />;
export const Shield = () => <Icon d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" />;
export const ShieldOff = () => <Icon d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM4 4l16 16" />;

export const Refresh = () => <Icon d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />;

export const More = () => <Icon d="M12 12h.01M5 12h.01M19 12h.01" />;
export const Pin = () => <Icon d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />;
export const Camera = () => <Icon d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />;
export const Share = () => <Icon d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" />;
export const Gauge = () => <Icon d="M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0" />;
export const Grid = () => <Icon d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />;
export const Alert = () => <Icon d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />;
export const Layers = () => <Icon d="M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5" />;
export const Database = () => <Icon d="M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />;
export const Command = () => <Icon d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z" />;

export const Puzzle = () => <Icon d="M19.4 12.6V8.5a2 2 0 0 0-2-2h-3.2a2.5 2.5 0 1 0-4.4 0H6.6a2 2 0 0 0-2 2v3.2a2.5 2.5 0 1 1 0 4.6v3.2a2 2 0 0 0 2 2h3.2a2.5 2.5 0 1 1 4.4 0h3.2a2 2 0 0 0 2-2v-4.1a2.5 2.5 0 1 1 0-3.8z" />;
export const Check = () => <Icon d="M5 12l5 5L20 7" />;
export const Copy = () => <Icon d="M9 9h11v11H9zM5 15V5a1 1 0 0 1 1-1h10" />;
