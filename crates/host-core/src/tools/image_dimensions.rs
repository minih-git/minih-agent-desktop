//! Header-only image geometry admission, mirrored by shared/image-dimensions.ts.
pub(crate) const MAX_INLINE_IMAGE_EDGE_PX: u32 = 8000;

fn u16_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let pair = bytes.get(offset..offset + 2)?;
    Some(u32::from(u16::from_be_bytes([pair[0], pair[1]])))
}
fn u16_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let pair = bytes.get(offset..offset + 2)?;
    Some(u32::from(u16::from_le_bytes([pair[0], pair[1]])))
}
fn u24_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let part = bytes.get(offset..offset + 3)?;
    Some(u32::from_le_bytes([part[0], part[1], part[2], 0]))
}
fn u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2;
    loop {
        if *bytes.get(offset)? != 0xff {
            return None;
        }
        match *bytes.get(offset + 1)? {
            0xff => offset += 1,
            0x01 | 0xd0..=0xd7 => offset += 2,
            0xd9 | 0xda => return None,
            marker @ 0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                return Some((u16_be(bytes, offset + 7)?, u16_be(bytes, offset + 5)?));
            }
            _ => {
                let length = u16_be(bytes, offset + 2)? as usize;
                if length < 2 {
                    return None;
                }
                offset += 2 + length;
            }
        }
    }
}

pub(crate) fn probe_image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if bytes.get(12..16)? != b"IHDR" {
            return None;
        }
        Some((u32_be(bytes, 16)?, u32_be(bytes, 20)?))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        jpeg_dimensions(bytes)
    } else if bytes.starts_with(b"GIF8") {
        Some((u16_le(bytes, 6)?, u16_le(bytes, 8)?))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        match bytes.get(12..16)? {
            b"VP8X" => Some((u24_le(bytes, 24)? + 1, u24_le(bytes, 27)? + 1)),
            b"VP8L" if bytes.get(20) == Some(&0x2f) => {
                let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"VP8 " if bytes.get(23..26)? == [0x9d, 0x01, 0x2a] => {
                Some((u16_le(bytes, 26)? & 0x3fff, u16_le(bytes, 28)? & 0x3fff))
            }
            _ => None,
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 2, 0, 0, 0]);
        bytes
    }
    #[test]
    fn reads_png_gif_and_jpeg() {
        assert_eq!(probe_image_dimensions(&png(780, 14182)), Some((780, 14182)));
        let gif = [b"GIF89a".as_slice(), &[0x40, 1, 0xc8, 0, 0, 0, 0]].concat();
        assert_eq!(probe_image_dimensions(&gif), Some((320, 200)));
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0];
        jpeg.extend([0xff, 0xc0, 0, 17, 8, 5, 0xea, 6, 0x98, 3]);
        assert_eq!(probe_image_dimensions(&jpeg), Some((1688, 1514)));
    }
    #[test]
    fn reads_all_webp_headers() {
        let mut extended = b"RIFF\x00\x00\x00\x00WEBPVP8X".to_vec();
        extended.extend([0; 8]);
        extended.extend([0x0b, 3, 0, 0x65, 0x37, 0]);
        assert_eq!(probe_image_dimensions(&extended), Some((780, 14182)));
        let mut lossless = b"RIFF\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00\x2f".to_vec();
        let bits: u32 = (780 - 1) | ((1000 - 1) << 14);
        lossless.extend(bits.to_le_bytes());
        assert_eq!(probe_image_dimensions(&lossless), Some((780, 1000)));
        let mut lossy = b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec();
        lossy.extend([0, 0, 0, 0, 0, 0, 0, 0x9d, 1, 0x2a, 0x0c, 3, 0xe8, 3]);
        assert_eq!(probe_image_dimensions(&lossy), Some((780, 1000)));
    }
    #[test]
    fn unknown_and_truncated_headers_are_undecided() {
        assert_eq!(probe_image_dimensions(b"plain text"), None);
        assert_eq!(probe_image_dimensions(&png(10, 10)[..20]), None);
        assert_eq!(probe_image_dimensions(b"\xff\xd8\xff\xda\x00\x02"), None);
        assert_eq!(probe_image_dimensions(b"\xff\xd8\xffgarbage"), None);
    }
}
