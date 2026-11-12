/**
 * 跨多多科技 · Ant Design v5 主题令牌
 * 用法：
 *   import { ConfigProvider } from "antd";
 *   import kkAntdTheme from "./kk-antd-theme.js";
 *   <ConfigProvider theme={kkAntdTheme}>…</ConfigProvider>
 */
const kkAntdTheme = {
  token: {
    colorPrimary: "#15171E", // 主色墨黑（不是荧光绿：antd 的 primary 会用于链接/选中态，绿字读不清）
    colorInfo: "#5A6274",
    colorSuccess: "#2E9E6B",
    colorWarning: "#D8971A",
    colorError: "#E0553F",

    colorBgBase: "#FFFFFF",
    colorBgLayout: "#ECEFF2",
    colorBgContainer: "#FFFFFF",
    colorFillSecondary: "#F5F6F8",
    colorBorder: "#E4E7EB",
    colorBorderSecondary: "#E4E7EB",

    colorText: "#15171E",
    colorTextSecondary: "#5A6274",
    colorTextTertiary: "#838CA0",
    colorTextQuaternary: "#A6ADBD",

    borderRadius: 10,
    borderRadiusLG: 20,
    borderRadiusSM: 8,

    fontFamily:
      '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 13,

    boxShadow: "0 1px 2px rgba(21,23,30,.04), 0 10px 26px -20px rgba(21,23,30,.35)",
    boxShadowSecondary: "0 2px 8px rgba(21,23,30,.05), 0 24px 48px -26px rgba(21,23,30,.4)"
  },
  components: {
    // 主按钮改成"荧光绿 + 墨黑字"，与跨多多的 CTA 一致
    Button: {
      colorPrimary: "#D8FA34",
      colorPrimaryHover: "#BCE600",
      colorPrimaryActive: "#BCE600",
      primaryColor: "#181A0C",
      primaryShadow: "0 6px 16px -8px rgba(188,230,0,.85)",
      fontWeight: 600
    },
    Card: {
      borderRadiusLG: 20,
      paddingLG: 16
    },
    Menu: {
      itemSelectedBg: "#D8FA34",
      itemSelectedColor: "#181A0C"
    },
    Tag: {
      borderRadiusSM: 999
    }
  }
};

export default kkAntdTheme;
