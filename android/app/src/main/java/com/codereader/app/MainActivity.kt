package com.codereader.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader

    companion object {
        private const val PREFS_NAME = "codereader_prefs"
        private const val KEY_SERVER_URL = "server_url"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/static/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = findViewById(R.id.webview)
        setupWebView()

        val serverUrl = getServerUrlPref()
        if (serverUrl.isNullOrEmpty()) {
            showServerUrlDialog(isFirstLaunch = true)
        } else {
            loadApp()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = false
            setSupportZoom(false)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }
        }

        webView.webChromeClient = WebChromeClient()

        webView.addJavascriptInterface(CodeReaderJSInterface(), "CodeReaderAndroid")
    }

    private fun loadApp() {
        webView.loadUrl("https://appassets.androidplatform.net/static/index.html")
    }

    private fun getServerUrlPref(): String? {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_SERVER_URL, null)
    }

    private fun setServerUrlPref(url: String) {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_SERVER_URL, url).apply()
    }

    private fun showServerUrlDialog(isFirstLaunch: Boolean = false) {
        val input = EditText(this).apply {
            hint = getString(R.string.server_url_hint)
            val currentUrl = getServerUrlPref()
            if (!currentUrl.isNullOrEmpty()) {
                setText(currentUrl)
            }
            setPadding(48, 32, 48, 32)
        }

        val container = FrameLayout(this).apply {
            val params = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                marginStart = 16
                marginEnd = 16
            }
            addView(input, params)
        }

        val builder = AlertDialog.Builder(this)
            .setTitle(getString(R.string.server_url_title))
            .setView(container)
            .setPositiveButton(getString(R.string.btn_ok)) { _, _ ->
                val url = input.text.toString().trim().trimEnd('/')
                if (url.isNotEmpty()) {
                    setServerUrlPref(url)
                    if (isFirstLaunch) {
                        loadApp()
                    } else {
                        webView.evaluateJavascript(
                            "API.BASE = '${url}/api/v1'; location.reload();",
                            null
                        )
                    }
                }
            }

        if (!isFirstLaunch) {
            builder.setNegativeButton(getString(R.string.btn_cancel), null)
        }

        builder.setCancelable(!isFirstLaunch)
        builder.show()
    }

    @Deprecated("Use OnBackPressedCallback", ReplaceWith("onBackPressedDispatcher"))
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    inner class CodeReaderJSInterface {
        @JavascriptInterface
        fun getServerUrl(): String {
            return getServerUrlPref() ?: ""
        }

        @JavascriptInterface
        fun changeServerUrl() {
            runOnUiThread {
                showServerUrlDialog(isFirstLaunch = false)
            }
        }
    }
}
