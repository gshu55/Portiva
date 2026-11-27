use gpui_kit::{AssetSource, SharedString};
use std::borrow::Cow;

gpui_kit::assets::icon_assets!(
    PortivaIcons,
    [
        Server,
        Terminal,
        ArrowDownUp,
        Palette,
        KeyRound,
        Keyboard,
        FileText,
        Folder,
        File,
        FileSymlink,
        FileCode,
        FileArchive,
        FileImage,
        FileMusic,
        FileVideoCamera,
        FileCog,
        FileTerminal,
        FileSpreadsheet,
        FileQuestionMark,
        Image,
        Moon,
        Sun,
        Monitor,
        Save,
        Plug,
        FolderOpen,
        Folders,
        Columns2,
        Rows2,
        PanelRightClose,
        PanelRightOpen,
        PanelLeftClose,
        PanelLeftOpen,
        ArrowLeftRight,
        ArrowUp,
        RefreshCw,
        Upload,
        Download,
        FolderUp,
        FolderPlus,
        Pencil,
        Trash,
        Cpu,
        MemoryStick,
        HardDrive,
        ChevronDown,
        Plus,
        X,
    ]
);

pub struct AppAssets;
impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = PortivaIcons.load(path)? {
            return Ok(Some(bytes));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(PortivaIcons.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
