use std::net::Ipv4Addr;

use crate::domain::network_scan::NetworkInterfaceInfo;
use crate::services::network_scan_subnet::{netmask_prefix, prefix_mask};

pub(crate) fn list_network_interfaces() -> Result<Vec<NetworkInterfaceInfo>, String> {
    let mut interfaces = platform_interfaces()?;
    interfaces.sort_by_key(|interface| {
        (
            interface.is_loopback,
            !interface.is_private,
            interface.name.to_lowercase(),
            u32::from(
                interface
                    .address
                    .parse::<Ipv4Addr>()
                    .unwrap_or(Ipv4Addr::UNSPECIFIED),
            ),
        )
    });
    interfaces.dedup_by(|left, right| left.name == right.name && left.address == right.address);
    Ok(interfaces)
}

fn interface_info(
    name: String,
    address: Ipv4Addr,
    prefix_length: u8,
    is_loopback: bool,
) -> NetworkInterfaceInfo {
    debug_assert_eq!(
        netmask_prefix(Ipv4Addr::from(prefix_mask(prefix_length))),
        Some(prefix_length)
    );
    let network = Ipv4Addr::from(u32::from(address) & prefix_mask(prefix_length));
    NetworkInterfaceInfo {
        name,
        address: address.to_string(),
        prefix_length,
        cidr: format!("{network}/{prefix_length}"),
        is_loopback,
        is_private: address.is_private(),
    }
}

#[cfg(unix)]
fn platform_interfaces() -> Result<Vec<NetworkInterfaceInfo>, String> {
    use std::ffi::CStr;
    use std::ptr;

    struct IfAddrsGuard(*mut libc::ifaddrs);
    impl Drop for IfAddrsGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { libc::freeifaddrs(self.0) };
            }
        }
    }

    let mut first = ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut first) } != 0 {
        return Err(format!(
            "读取本机网络接口失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let _guard = IfAddrsGuard(first);
    let mut interfaces = Vec::new();
    let mut current = first;

    while !current.is_null() {
        let item = unsafe { &*current };
        let address_ptr = item.ifa_addr;
        let netmask_ptr = item.ifa_netmask;
        let is_up = item.ifa_flags & libc::IFF_UP as u32 != 0;
        if is_up
            && !address_ptr.is_null()
            && !netmask_ptr.is_null()
            && unsafe { (*address_ptr).sa_family as i32 } == libc::AF_INET
        {
            let address = unsafe {
                let socket = &*(address_ptr as *const libc::sockaddr_in);
                Ipv4Addr::from(socket.sin_addr.s_addr.to_ne_bytes())
            };
            let netmask = unsafe {
                let socket = &*(netmask_ptr as *const libc::sockaddr_in);
                Ipv4Addr::from(socket.sin_addr.s_addr.to_ne_bytes())
            };
            if let Some(prefix_length) = netmask_prefix(netmask) {
                let name = if item.ifa_name.is_null() {
                    "network".to_string()
                } else {
                    unsafe { CStr::from_ptr(item.ifa_name) }
                        .to_string_lossy()
                        .into_owned()
                };
                interfaces.push(interface_info(
                    name,
                    address,
                    prefix_length,
                    item.ifa_flags & libc::IFF_LOOPBACK as u32 != 0,
                ));
            }
        }
        current = item.ifa_next;
    }

    Ok(interfaces)
}

#[cfg(windows)]
fn platform_interfaces() -> Result<Vec<NetworkInterfaceInfo>, String> {
    use std::ffi::CStr;
    use std::ptr;

    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut buffer_size = 15 * 1024u32;
    let mut buffer = Vec::<u64>::new();

    loop {
        buffer.resize(buffer_size.div_ceil(size_of::<u64>() as u32) as usize, 0);
        let first = buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        let result = unsafe {
            GetAdaptersAddresses(AF_INET as u32, flags, ptr::null(), first, &mut buffer_size)
        };
        if result == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if result != NO_ERROR {
            return Err(format!("读取 Windows 网络接口失败，系统错误码：{result}"));
        }

        let mut interfaces = Vec::new();
        let mut adapter_ptr = first;
        while !adapter_ptr.is_null() {
            let adapter = unsafe { &*adapter_ptr };
            if adapter.OperStatus == IfOperStatusUp {
                let is_loopback = adapter.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
                let friendly_name = unsafe { wide_string(adapter.FriendlyName) };
                let adapter_name = if adapter.AdapterName.is_null() {
                    "network".to_string()
                } else {
                    unsafe { CStr::from_ptr(adapter.AdapterName.cast()) }
                        .to_string_lossy()
                        .into_owned()
                };
                let name = if friendly_name.is_empty() {
                    adapter_name
                } else {
                    friendly_name
                };
                let mut unicast_ptr = adapter.FirstUnicastAddress;
                while !unicast_ptr.is_null() {
                    let unicast = unsafe { &*unicast_ptr };
                    let sockaddr = unicast.Address.lpSockaddr;
                    if !sockaddr.is_null()
                        && unsafe { (*sockaddr).sa_family } == AF_INET
                        && unicast.OnLinkPrefixLength <= 32
                    {
                        let socket = unsafe { &*(sockaddr as *const SOCKADDR_IN) };
                        let raw_address = unsafe { socket.sin_addr.S_un.S_addr };
                        let address = Ipv4Addr::from(raw_address.to_ne_bytes());
                        if !address.is_unspecified() {
                            interfaces.push(interface_info(
                                name.clone(),
                                address,
                                unicast.OnLinkPrefixLength,
                                is_loopback,
                            ));
                        }
                    }
                    unicast_ptr = unicast.Next;
                }
            }
            adapter_ptr = adapter.Next;
        }
        return Ok(interfaces);
    }
}

#[cfg(windows)]
unsafe fn wide_string(pointer: windows_sys::core::PWSTR) -> String {
    if pointer.is_null() {
        return String::new();
    }
    let mut length = 0usize;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}

#[cfg(test)]
mod tests {
    use super::{interface_info, list_network_interfaces};
    use std::net::Ipv4Addr;

    #[test]
    fn builds_cidr_from_interface_address_and_prefix() {
        let interface = interface_info(
            "Ethernet".to_string(),
            Ipv4Addr::new(192, 168, 12, 41),
            24,
            false,
        );
        assert_eq!(interface.cidr, "192.168.12.0/24");
        assert!(interface.is_private);
    }

    #[test]
    fn platform_interface_enumeration_succeeds() {
        list_network_interfaces().unwrap();
    }
}
