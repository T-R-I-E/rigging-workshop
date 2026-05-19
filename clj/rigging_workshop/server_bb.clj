(ns rigging-workshop.server-bb
  "Sidecar HTTP server for toda-bb's rig interpreter. Runs in its own JVM on
   port 7879 because toda-bb's `toda.shielding` namespace collides with
   toda-core's (transitively required by twist-maker and toda-rig-checker
   in the main server). Co-loading them in one JVM silently overwrites the
   shared namespace and breaks both interpreters.

   POST /rigcheck-bb?cork=<hex>[&twist=<hex>]  octet-stream .toda bytes
        → {colour: green|yellow|red}"
  (:require [toda.core         :as bb-core]
            [toda.graph        :as bb-graph]
            [toda.atom         :as bb-atom]
            [toda.lat          :as bb-lat]
            [clojure.data.json :as json]
            [clojure.java.io   :as io]
            [clojure.string    :as str])
  (:import  [com.sun.net.httpserver HttpServer HttpHandler HttpExchange]
            [java.net InetSocketAddress]
            [java.io  ByteArrayInputStream ByteArrayOutputStream]))

(def PORT 7879)

(defn- read-bytes [^HttpExchange ex]
  (let [baos (ByteArrayOutputStream.)]
    (io/copy (.getRequestBody ex) baos)
    (.toByteArray baos)))

(defn- add-cors! [^HttpExchange ex]
  (let [h (.getResponseHeaders ex)]
    (.add h "Access-Control-Allow-Origin"  "*")
    (.add h "Access-Control-Allow-Methods" "POST, OPTIONS")
    (.add h "Access-Control-Allow-Headers" "Content-Type")))

(defn- send-response! [^HttpExchange ex ^long status ^String content-type body]
  (add-cors! ex)
  (.add (.getResponseHeaders ex) "Content-Type" content-type)
  (let [^bytes payload (cond
                         (string? body) (.getBytes ^String body "UTF-8")
                         (bytes? body)  body
                         :else (byte-array body))]
    (.sendResponseHeaders ex status (alength payload))
    (with-open [os (.getResponseBody ex)]
      (.write os payload))))

(defn- send-options! [^HttpExchange ex]
  (add-cors! ex)
  (.sendResponseHeaders ex 204 -1)
  (.close (.getResponseBody ex)))

(defn- send-error! [^HttpExchange ex status reason]
  (let [payload (if (instance? Throwable reason)
                  (let [t ^Throwable reason
                        ed (ex-data t)]
                    (json/write-str (cond-> {:error true
                                             :type (.getName (.getClass t))
                                             :message (.getMessage t)}
                                      ed (assoc :data ed))))
                  (json/write-str {:error true
                                   :type "error"
                                   :message (str reason)}))]
    (send-response! ex status "application/json; charset=utf-8" payload)))

(defn- parse-query [^String q]
  (when (and q (not (str/blank? q)))
    (into {} (for [pair (str/split q #"&")
                   :let [[k v] (str/split pair #"=" 2)]]
               [(keyword k) v]))))

(defn- handle-rigcheck-bb
  "Run toda-bb's interpreter over the .toda body. cork query param is
   required (hex hash). twist query param is optional; defaults to the
   first end-twist of the populated graph."
  [^HttpExchange ex]
  (try
    (let [bytes (read-bytes ex)
          query (parse-query (.getQuery (.getRequestURI ex)))
          cork-hex  (:cork query)
          atoms (with-open [is (ByteArrayInputStream. bytes)]
                  (bb-atom/multi-from-input-stream is))
          lat   (bb-lat/lat atoms)
          conn  (bb-core/create-graph)
          _     (bb-graph/populate-twists conn lat)
          focus-hex (or (:twist query)
                        (some-> (bb-graph/get-end-twists conn) first :twist/id)
                        cork-hex)
          colour (bb-core/verify-rig conn cork-hex focus-hex)
          payload (json/write-str {:colour (name colour)})]
      (send-response! ex 200 "application/json; charset=utf-8" payload))
    (catch Throwable t
      (.printStackTrace t)
      (send-error! ex 400 t))))

(defn- handle-health [^HttpExchange ex]
  (send-response! ex 200 "text/plain" "ok"))

(defn- make-handler [f]
  (reify HttpHandler
    (handle [_ ex]
      (case (.getRequestMethod ex)
        "OPTIONS" (send-options! ex)
        "POST"    (f ex)
        "GET"     (f ex)
        (send-error! ex 405 "method not allowed")))))

(defn -main [& _]
  (let [server (HttpServer/create (InetSocketAddress. PORT) 0)]
    (.createContext server "/rigcheck-bb" (make-handler handle-rigcheck-bb))
    (.createContext server "/health"      (make-handler handle-health))
    (.setExecutor server nil)
    (.start server)
    (println (str "rigging-workshop bb-server on http://localhost:" PORT))))
