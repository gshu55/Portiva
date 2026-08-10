use std::net::Ipv4Addr;

const MAX_SCAN_HOSTS: usize = 4096;

pub(crate) fn prefix_mask(prefix_length: u8) -> u32 {
    if prefix_length == 0 {
        0
    } else {
        u32::MAX << (32 - prefix_length)
    }
}

pub(crate) fn netmask_prefix(netmask: Ipv4Addr) -> Option<u8> {
    let mask = u32::from(netmask);
    let prefix = mask.count_ones() as u8;
    (mask == prefix_mask(prefix)).then_some(prefix)
}

pub(crate) fn cidr_hosts(cidr: &str) -> Result<Vec<Ipv4Addr>, String> {
    let (address, prefix) = cidr
        .split_once('/')
        .ok_or_else(|| "网段格式无效，请使用 192.168.1.0/24 形式".to_string())?;
    let address = address
        .trim()
        .parse::<Ipv4Addr>()
        .map_err(|_| "当前版本仅支持 IPv4 CIDR 网段".to_string())?;
    let prefix = prefix
        .trim()
        .parse::<u8>()
        .map_err(|_| "CIDR 前缀长度无效".to_string())?;
    if prefix > 32 {
        return Err("CIDR 前缀长度必须在 0–32 之间".to_string());
    }

    let mask = prefix_mask(prefix);
    let network = u32::from(address) & mask;
    let broadcast = network | !mask;
    let (first, last) = if prefix >= 31 {
        (network, broadcast)
    } else {
        (network.saturating_add(1), broadcast.saturating_sub(1))
    };
    let count = (u64::from(last) - u64::from(first) + 1) as usize;
    if count > MAX_SCAN_HOSTS {
        return Err(format!(
            "网段包含 {count} 个地址，超过单次扫描上限 {MAX_SCAN_HOSTS}；请缩小 CIDR 范围"
        ));
    }

    Ok((first..=last).map(Ipv4Addr::from).collect())
}

#[cfg(test)]
mod tests {
    use super::{cidr_hosts, netmask_prefix};
    use std::net::Ipv4Addr;

    #[test]
    fn expands_regular_subnet_without_network_and_broadcast_addresses() {
        assert_eq!(
            cidr_hosts("192.168.10.0/30").unwrap(),
            vec![
                Ipv4Addr::new(192, 168, 10, 1),
                Ipv4Addr::new(192, 168, 10, 2)
            ]
        );
    }

    #[test]
    fn keeps_both_point_to_point_addresses() {
        assert_eq!(cidr_hosts("10.0.0.8/31").unwrap().len(), 2);
        assert_eq!(
            cidr_hosts("10.0.0.9/32").unwrap(),
            vec![Ipv4Addr::new(10, 0, 0, 9)]
        );
    }

    #[test]
    fn rejects_oversized_subnets() {
        assert!(cidr_hosts("10.0.0.0/19")
            .unwrap_err()
            .contains("超过单次扫描上限"));
    }

    #[test]
    fn only_accepts_contiguous_netmasks() {
        assert_eq!(netmask_prefix(Ipv4Addr::new(255, 255, 255, 0)), Some(24));
        assert_eq!(netmask_prefix(Ipv4Addr::new(255, 0, 255, 0)), None);
    }
}
