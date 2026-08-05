import { Icon } from "../../shared/Icon";

interface SftpDropOverlayProps {
  active: boolean;
  className: string;
}

export function SftpDropOverlay({ active, className }: SftpDropOverlayProps) {
  return (
    <div className={className} aria-hidden={!active}>
      <Icon name="upload" />
      <div>
        <strong>释放上传到当前目录</strong>
        <small>多文件和多目录将合并为一个递归任务</small>
      </div>
    </div>
  );
}
