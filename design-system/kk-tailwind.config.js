/**
 * 跨多多科技 · Tailwind 主题扩展
 * 用法：在 tailwind.config.js 里 const kk = require("./kk-tailwind.config.js");
 *       module.exports = { theme: { extend: kk.extend } };
 */
module.exports = {
  extend: {
    colors: {
      kk: {
        bg: "#ECEFF2",
        surface: "#FFFFFF",
        hover: "#F5F6F8",
        border: "#E4E7EB",
        borderStrong: "#D3D8DE",
        text: "#15171E",
        text2: "#5A6274",
        text3: "#838CA0",
        text4: "#A6ADBD",
        ink: "#15171E",
        inkHover: "#2B2F37",
        lime: "#D8FA34",
        limeDeep: "#BCE600",
        limeInk: "#181A0C",
        greenInk: "#4E9E00",
        greenBright: "#86D000",
        success: "#2E9E6B",
        warning: "#D8971A",
        danger: "#E0553F",
        info: "#5A6274"
      }
    },
    borderRadius: {
      kk: "14px",
      "kk-sm": "10px",
      "kk-lg": "20px",
      "kk-xl": "28px"
    },
    boxShadow: {
      kk: "0 1px 2px rgba(21,23,30,.04), 0 10px 26px -20px rgba(21,23,30,.35)",
      "kk-md": "0 2px 8px rgba(21,23,30,.05), 0 24px 48px -26px rgba(21,23,30,.4)",
      "kk-lime": "0 6px 16px -8px rgba(188,230,0,.85)"
    },
    fontSize: {
      "kk-caption": ["10.5px", { lineHeight: "1.2", letterSpacing: "2.4px" }],
      "kk-xs": ["11.5px", { lineHeight: "1.6" }],
      "kk-sm": ["12.5px", { lineHeight: "1.4" }],
      "kk-base": ["13.5px", { lineHeight: "1.7" }],
      "kk-btn": ["14.5px", { lineHeight: "1" }],
      "kk-card": ["20px", { lineHeight: "1.35" }],
      "kk-title": ["30px", { lineHeight: "1.2", letterSpacing: "-0.6px" }],
      "kk-hero": ["50px", { lineHeight: "1.1", letterSpacing: "-1.2px" }]
    },
    fontFamily: {
      kk: ['-apple-system', '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"],
      "kk-mono": ["ui-monospace", "Consolas", "monospace"]
    },
    spacing: {
      "kk-1": "4px",
      "kk-2": "8px",
      "kk-3": "12px",
      "kk-4": "16px",
      "kk-5": "24px",
      "kk-6": "32px",
      "kk-7": "48px"
    },
    transitionTimingFunction: {
      kk: "cubic-bezier(.4,0,.2,1)"
    }
  }
};
