(ns rigging-workshop.server-bb-test
  "Tests for the toda-bb HTTP bridge in server_bb.clj. Runs in a SEPARATE
   JVM from server-test because toda-bb's toda.shielding ns collides with
   toda-core's same-named ns. Use the :test-bb alias, not :test."
  (:require [clojure.test :refer [deftest is testing]]
            [rigging-workshop.server-bb :as bb-srv]
            [twist-maker.core :as core]
            [twist-maker.trdl :as trdl]
            [common.util      :as u]))

(def ^:private bad-rig-trdl
  "Same designed-bad rig as the canonical-side test
   (rigs/7-corkline-self-tether.trdl): line `a` has tether loops that
   make the fastener history equivocal. bb agrees with clj/js/rust
   that this is non-green."
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
        {:keys [bytes corkline-h]} (core/build spec)]
    {:bytes    (u/bytes->byte-array bytes)
     :cork-hex (str corkline-h)}))

(defn- trace-nodes [trace]
  (when trace
    (cons trace (mapcat trace-nodes (vals (:children trace))))))

(deftest bb-rigcheck-returns-structured-trace-on-failure
  (let [{:keys [bytes cork-hex]} (compile-bad-rig)
        {:keys [colour trace]} (bb-srv/rigcheck-bytes bytes cork-hex nil)]
    (testing "designed-bad rig fails the bb interpreter"
      (is (contains? #{"red" "yellow"} colour)
          (str "expected non-green, got " colour)))
    (testing "trace tree is rooted at rig"
      (is (some? trace))
      (is (= "rig"  (:structype trace)))
      (is (= colour (:colour    trace))))
    (testing "trace pinpoints a non-green substructure with an issue"
      (let [bad-nodes (filter (fn [n] (and (:issue n)
                                           (not= "green" (:colour n))))
                              (trace-nodes trace))]
        (is (seq bad-nodes)
            "bb trace must carry at least one node with an issue")
        (doseq [n bad-nodes]
          (is (string? (:structype n)))
          (is (string? (:issue n))))))))
