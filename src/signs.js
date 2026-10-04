// Shop signboard lettering: an atlas of generic Vietnamese shop names drawn on a canvas at load time (white text on
// black, used as a mask; the board and ink colours come from the house shaders). No brands, no phone numbers.
// 32 cells of 512 x 128 px (4 columns, 8 rows); houses.js and kit.js pick a cell from each house's seed.
import * as THREE from 'three';

export const SIGN_CELLS = [4, 8];
const SIGNS = [
  ['TẠP HÓA', 'BÁNH KẸO - NƯỚC GIẢI KHÁT'], ['CƠM TẤM', 'SƯỜN BÌ CHẢ'], ['PHỞ BÒ', 'HỦ TIẾU - MÌ'],
  ['CÀ PHÊ', 'GIẢI KHÁT - SINH TỐ'], ['NHÀ THUỐC', 'TÂY Y - ĐÔNG Y'], ['ĐIỆN THOẠI', 'SỬA CHỮA - PHỤ KIỆN'],
  ['SỬA XE', 'VÁ VỎ - THAY NHỚT'], ['TIỆM VÀNG', 'MUA BÁN VÀNG BẠC'], ['VẬT LIỆU XÂY DỰNG', 'SẮT THÉP - XI MĂNG'],
  ['BÚN MẮM', 'BÚN RIÊU - BÚN BÒ'], ['NHA KHOA', 'NIỀNG RĂNG - TRỒNG RĂNG'], ['THỜI TRANG', 'QUẦN ÁO NAM NỮ'],
  ['ĐIỆN MÁY', 'TIVI - TỦ LẠNH - MÁY LẠNH'], ['NHÀ NGHỈ', 'PHÒNG LẠNH - GIÁ RẺ'], ['QUÁN NHẬU', 'LẨU - NƯỚNG'],
  ['TIỆM TÓC', 'CẮT - UỐN - NHUỘM'], ['ĐẠI LÝ GẠO', 'GẠO CÁC LOẠI'], ['BÁNH MÌ', 'XÍU MẠI - THỊT NGUỘI'],
  ['ĐIỆN NƯỚC', 'THIẾT BỊ VỆ SINH'], ['VĂN PHÒNG PHẨM', 'SÁCH VỞ - PHOTO'], ['TRÀ SỮA', 'ĂN VẶT'],
  ['MẮT KÍNH', 'ĐO MẮT MIỄN PHÍ'], ['ĐỒNG HỒ', 'SỬA CHỮA - THAY PIN'], ['HỦ TIẾU', 'NAM VANG - CHÁO LÒNG'],
  ['MẮM CHÂU ĐỐC', 'ĐẶC SẢN AN GIANG'], ['ĐƯỜNG THỐT NỐT', 'ĐẶC SẢN BẢY NÚI'], ['PHÒNG KHÁM', 'NỘI - NHI'],
  ['NỆM - DRAP', 'GỐI - MỀN'], ['NÔNG DƯỢC', 'PHÂN BÓN - GIỐNG LÚA'], ['SPA', 'CHĂM SÓC DA'],
  ['IN ẤN', 'BẢNG HIỆU - QUẢNG CÁO'], ['GỐM SỨ', 'ĐỒ GIA DỤNG'],
];

let atlas = null;
/** The lettering atlas (one shared texture). */
export function signAtlas() {
  if (atlas) return atlas;
  const W = 512, H = 128, [nc, nr] = SIGN_CELLS;
  const cv = document.createElement('canvas');
  cv.width = W * nc; cv.height = H * nr;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fit = (text, size, maxW, weight) => {              // largest font size up to `size` that fits
    let s = size;
    do { g.font = `${weight} ${s}px "Arial", "Segoe UI", "Helvetica Neue", sans-serif`; s -= 2; } while (g.measureText(text).width > maxW && s > 10);
  };
  SIGNS.forEach(([name, sub], i) => {
    const x = (i % nc) * W + W / 2, y = Math.floor(i / nc) * H;
    fit(name, 66, W - 36, 'bold');
    g.fillText(name, x, y + 50);
    fit(sub, 26, W - 60, 'bold');
    g.fillText(sub, x, y + 102);
  });
  atlas = new THREE.CanvasTexture(cv);
  atlas.flipY = false;                                       // v = 0 at the top of the canvas
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.anisotropy = 8;
  return atlas;
}
