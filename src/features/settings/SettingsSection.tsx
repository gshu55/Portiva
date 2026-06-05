interface SettingsSectionHeaderProps {
  description?: string;
  meta?: string;
  title: string;
}

export function SettingsSectionHeader({ description, meta, title }: SettingsSectionHeaderProps) {
  return (
    <div className="settings-section-header">
      <div>
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}
