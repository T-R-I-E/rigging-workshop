(ns rigging-workshop.server-test
  "Tests for the canonical (toda-rig-checker) HTTP bridge in server.clj.
   The focus is on the structured failure trace: when rig-check fails,
   the response must explain *why* — not just \"red\"."
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.data.json :as json]
            [rigging-workshop.server :as srv]
            [twist-maker.core   :as core]
            [twist-maker.trdl   :as trdl]
            [lat.core           :as lat]
            [common.util        :as u]))

(def ^:private bad-rig-trdl
  "Designed-bad rig (rigs/7-corkline-self-tether.trdl): line `a` has
   tether loops that make the fastener history equivocal. All four
   checkers (js, clj, bb, rust) agree this is non-green, so it's a
   reliable fixture for asserting that the failure surfaces a
   structured reason rather than just \"red\"."
  (str "{\"rig\":\"Corkline self-tether\"}\n"
       "{\"line\":\"poptop\",\"twists\":2,\"shielded\":false,\"reqsat\":\"null\"}\n"
       "{\"line\":\"a\",\"twists\":4,\"shielded\":false,\"reqsat\":\"null\"}\n"
       "{\"line\":\"abject\",\"twists\":2,\"shielded\":false,\"reqsat\":\"null\"}\n"
       "{\"hitch\":\"Pb1\",\"lead\":\"abject[0]\",\"meet\":\"abject[1]\",\"fastener\":\"a[1]\",\"hoist\":\"a[2]\"}\n"
       "{\"twist\":\"a[1]\",\"teth\":\"a[0]\"}\n"
       "{\"twist\":\"a[3]\",\"teth\":\"a[2]\"}"))

(defn- compile-bad-rig []
  (let [entities (trdl/parse-trdl-string bad-rig-trdl)
        spec     (trdl/trdl->spec entities)
        {:keys [bytes corkline-h twists]} (core/build spec)
        ;; The focus we want the rig-checker to evaluate is the abject's
        ;; meet (abject[1] — the bottom hitch's meet). Without this, the
        ;; default focus in the seeded lat is the topline twist on line
        ;; `a`, which has no hitch above it and trivially returns green.
        focus-h  (lat/focus (get twists :abject_1))]
    {:bytes    (u/bytes->byte-array bytes)
     :cork-hex (str corkline-h)
     :twist-hex (str focus-h)}))

(defn- trace-nodes
  "Depth-first seq of every node in a trace tree (parent first)."
  [trace]
  (when trace
    (cons trace (mapcat trace-nodes (vals (:children trace))))))

(deftest rigcheck-returns-structured-trace-on-failure
  (let [{:keys [bytes cork-hex twist-hex]} (compile-bad-rig)
        {:keys [colour trace]} (srv/rigcheck-bytes bytes cork-hex twist-hex)]

    (testing "the overall colour is non-green"
      (is (contains? #{"red" "yellow"} colour)
          (str "expected designed-bad rig to fail, got " colour)))

    (testing "a trace is included in the response"
      (is (some? trace) "no trace returned")
      (is (= "rig"     (:structype trace)))
      (is (= colour    (:colour    trace))))

    (testing "the trace explains which substructure is bad"
      (let [nodes      (trace-nodes trace)
            bad-leaves (filter (fn [n] (and (:issue n)
                                            (not= "green" (:colour n))))
                               nodes)]
        (is (seq bad-leaves)
            "trace must carry at least one node with a non-green issue")
        (let [{:keys [structype colour issue]} (first bad-leaves)]
          (is (string? structype))
          (is (contains? #{"red" "yellow"} colour))
          (is (string? issue))
          (is (contains? #{"INVALID" "MISMATCH" "MISSING" "UNKNOWN"
                           "NO-SPEC-ERROR" "ATOMIC-ERROR"
                           "SHAPE-ERROR" "LAT-ERROR"}
                         issue)
              (str "issue " (pr-str issue) " not in known set")))))

    (testing "the response is JSON-serializable end-to-end"
      (let [round-trip (-> {:colour colour :trace trace}
                           json/write-str
                           (json/read-str :key-fn keyword))]
        (is (= colour (:colour round-trip)))
        (is (= (:structype trace) (:structype (:trace round-trip))))))))

(deftest rigcheck-trace-tree-is-well-formed
  (let [{:keys [bytes cork-hex]} (compile-bad-rig)
        {:keys [trace]} (srv/rigcheck-bytes bytes cork-hex nil)]
    (testing "every node has structype + colour"
      (doseq [n (trace-nodes trace)]
        (is (string? (:structype n)) (pr-str n))
        (is (contains? #{"red" "yellow" "green"} (:colour n)) (pr-str n))))
    (testing "children, when present, are a non-empty map of trees"
      (doseq [n (trace-nodes trace)]
        (when-let [ch (:children n)]
          (is (map? ch))
          (is (seq ch))
          (doseq [[k v] ch]
            (is (string? k))
            (is (map? v))))))))
