pub fn progress_percent(transferred_bytes: u64, total_bytes: Option<u64>) -> u8 {
    let Some(total) = total_bytes else {
        return 0;
    };

    if total == 0 {
        return 100;
    }

    let percent = transferred_bytes.saturating_mul(100) / total;
    percent.min(100) as u8
}

#[cfg(test)]
mod tests {
    use super::progress_percent;

    #[test]
    fn handles_unknown_total() {
        assert_eq!(progress_percent(10, None), 0);
    }

    #[test]
    fn clamps_at_one_hundred() {
        assert_eq!(progress_percent(150, Some(100)), 100);
    }

    #[test]
    fn handles_empty_files() {
        assert_eq!(progress_percent(0, Some(0)), 100);
    }
}
